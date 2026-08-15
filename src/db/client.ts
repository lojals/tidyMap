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
 * Creates the schema. Written as idempotent DDL rather than drizzle-kit
 * migration files because Phase 1 has a single schema version and no
 * deployed database to migrate forward from.
 */
export function migrate(db: Db): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
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
}
