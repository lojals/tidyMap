import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export function createDb(url: string): Db {
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/**
 * SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and CREATE TABLE
 * IF NOT EXISTS silently does nothing when the table already exists — so a
 * column added after someone has already run the app never appears in their
 * database, and every read fails on the missing column. Guarded with
 * PRAGMA table_info rather than a try/catch around the ALTER so this stays
 * declarative and does not swallow a real failure (e.g. a locked database).
 */
function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  const existing = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`));
  if (existing.some((c) => c.name === column)) return;
  db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
}

/**
 * users.google_sub and users.email were dropped: Google rejects a scope
 * request that mixes Data Portability scopes with `openid`/`email`, so the
 * OAuth flow no longer receives an id_token and there is nothing to
 * populate either column with (see src/auth/oauth.ts).
 *
 * This cannot be a plain `ALTER TABLE ... DROP COLUMN`. google_sub was
 * declared `NOT NULL UNIQUE`, and UNIQUE creates an implicit index; SQLite's
 * DROP COLUMN refuses to drop a column backed by an index. Verified directly
 * against the installed better-sqlite3 (3.53.4):
 *
 *   ALTER TABLE users DROP COLUMN google_sub
 *   -> "cannot drop UNIQUE column: \"google_sub\""
 *
 * So this instead follows SQLite's documented twelve-step table-rebuild
 * procedure (https://www.sqlite.org/lang_altertable.html#otheralter): build
 * a replacement table in the new shape, copy the surviving columns across,
 * drop the old table, and rename the replacement into place.
 *
 * oauth_tokens.user_id and extractions.user_id hold foreign keys into
 * users(id), and this database runs with PRAGMA foreign_keys = ON
 * (src/db/client.ts's createDb). Rebuilding `users` — even transiently,
 * inside a transaction — would trip those foreign keys (or, on some SQLite
 * builds, refuse the DROP TABLE outright) unless they are switched off
 * first. PRAGMA foreign_keys is documented as a no-op when there is an open
 * transaction, so it must bracket the transaction rather than live inside
 * it. `id` and `created_at` are copied verbatim and the table name is
 * restored at the end, so every dependent row — and every foreign key
 * pointing at it — survives unchanged; `PRAGMA foreign_key_check` proves
 * that rather than assuming it.
 *
 * That check runs from *inside* the transaction, immediately after the
 * rename, and a violation throws before the transaction commits -- matching
 * SQLite's documented twelve-step procedure, which runs this exact check as
 * step 11, strictly before the COMMIT in step 12
 * (https://www.sqlite.org/lang_altertable.html#otheralter). Checking only
 * after db.transaction() returns would mean checking after the commit --
 * reporting damage instead of preventing it, and leaving a corrupted
 * database as the new permanent state.
 *
 * The check is scoped to `PRAGMA foreign_key_check(oauth_tokens)` and
 * `PRAGMA foreign_key_check(extractions)` -- the only two tables with a
 * foreign key into `users` -- rather than the unscoped, whole-database
 * `PRAGMA foreign_key_check`. The unscoped form also surfaces violations in
 * tables this migration never touches (e.g. raw_artifacts -> extractions,
 * places -> extractions); on a database that already has one of those from
 * some unrelated cause, an unscoped check would fail this migration -- and
 * therefore every future boot, since the rebuild is retried every time it
 * finds the legacy shape -- forever, for damage this code neither caused nor
 * can fix. Scoping keeps the guarantee this migration is actually
 * responsible for (every oauth_tokens/extractions row that pointed at a real
 * user before the rebuild still does after it) without turning unrelated
 * pre-existing corruption into a permanent boot blocker.
 */
function migrateUsersTableShape(db: Db): void {
  const columns = db.all<{ name: string }>(sql.raw('PRAGMA table_info(users)'));
  if (columns.length === 0) return; // no users table yet -- the CREATE TABLE below makes the current shape
  const hasOldColumns = columns.some((c) => c.name === 'google_sub' || c.name === 'email');
  if (!hasOldColumns) return; // already the current shape

  db.run(sql.raw('PRAGMA foreign_keys = OFF'));
  try {
    db.transaction((tx) => {
      tx.run(sql.raw(`CREATE TABLE users_new (
         id TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL
       )`));
      tx.run(sql.raw('INSERT INTO users_new (id, created_at) SELECT id, created_at FROM users'));
      tx.run(sql.raw('DROP TABLE users'));
      tx.run(sql.raw('ALTER TABLE users_new RENAME TO users'));

      // PRAGMA foreign_key_check(table) errors outright ("no such table") if
      // the named table does not exist yet -- true of a genuinely fresh
      // database that has only ever had its users table created (some tests
      // build exactly that), even though a real already-deployed database
      // being migrated here always has both. Guard rather than assume.
      const tablesToCheck = ['oauth_tokens', 'extractions'].filter(
        (table) =>
          tx.all(
            sql.raw(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`),
          ).length > 0,
      );
      const violations = tablesToCheck.flatMap((table) =>
        tx.all(sql.raw(`PRAGMA foreign_key_check(${table})`)),
      );
      if (violations.length > 0) {
        throw new Error(
          `users table rebuild left dangling foreign keys: ${JSON.stringify(violations)}`,
        );
      }
    });
  } finally {
    // Restored unconditionally: createDb() always turns foreign_keys ON, so
    // this migration must never be the reason a session ends up with them off.
    db.run(sql.raw('PRAGMA foreign_keys = ON'));
  }
}

/**
 * Creates the schema. Written as idempotent DDL rather than drizzle-kit
 * migration files because Phase 1 has a single schema version and no
 * deployed database to migrate forward from.
 */
export function migrate(db: Db): void {
  // Must run before the CREATE TABLE IF NOT EXISTS below: that statement is
  // a no-op against a users table that already exists in the old shape, so
  // an existing database would otherwise never reach the current one.
  migrateUsersTableShape(db);

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
       user_id TEXT PRIMARY KEY REFERENCES users(id),
       access_token TEXT NOT NULL,
       refresh_token TEXT,
       expires_at INTEGER NOT NULL,
       scopes TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS extractions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id),
       status TEXT NOT NULL,
       archive_job_id TEXT,
       error TEXT,
       warnings TEXT,
       stage TEXT,
       stage_detail TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS raw_artifacts (
       id TEXT PRIMARY KEY,
       extraction_id TEXT NOT NULL REFERENCES extractions(id),
       path TEXT NOT NULL,
       content BLOB NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS places (
       id TEXT PRIMARY KEY,
       extraction_id TEXT NOT NULL REFERENCES extractions(id),
       payload TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_states (
       state TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL
     )`,
  ];

  // db.run() accepts a raw SQL string and is what drizzle's own migrators use.
  // Do NOT reach for db.$client — it exists only on the intersection type
  // drizzle() returns, so using it would force widening the exported Db type
  // and leak the raw driver handle to every consumer.
  for (const statement of statements) {
    db.run(statement);
  }

  // extractions.warnings was added after the initial schema shipped. The
  // CREATE TABLE IF NOT EXISTS above is a no-op against a database that
  // already has the extractions table, so the column needs its own
  // idempotent step to reach a pre-existing database.
  addColumnIfMissing(db, 'extractions', 'warnings', 'TEXT');

  // extractions.stage/stage_detail were added after the initial schema
  // shipped, same reasoning as warnings above: CREATE TABLE IF NOT EXISTS is
  // a no-op against a database that already has the extractions table.
  addColumnIfMissing(db, 'extractions', 'stage', 'TEXT');
  addColumnIfMissing(db, 'extractions', 'stage_detail', 'TEXT');
}
