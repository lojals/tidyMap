import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/**
 * `BetterSQLite3Database<typeof schema>` (drizzle's query-builder class) does
 * not itself declare `$client`. The `drizzle()` factory below actually
 * returns `BetterSQLite3Database<TSchema> & { $client: Database }` — see
 * node_modules/drizzle-orm/better-sqlite3/driver.d.ts — so `Db` mirrors that
 * intersection to keep `$client` visible to callers such as `migrate()`.
 */
export type Db = BetterSQLite3Database<typeof schema> & { $client: DatabaseInstance };

export function createDb(url: string): Db {
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
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
  ];

  for (const statement of statements) {
    db.$client.exec(statement);
  }
}
