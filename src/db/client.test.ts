import { describe, it, expect } from 'vitest';
import { createDb, migrate } from './client.js';
import { users, extractions, oauthTokens, rawArtifacts, places, oauthStates } from './schema.js';
import { eq, sql } from 'drizzle-orm';
import type { ResolvedPlace } from '../domain/types.js';

describe('createDb', () => {
  it('creates every table on migrate and round-trips a row', () => {
    const db = createDb(':memory:');
    migrate(db);

    db.insert(users).values({
      id: 'u1', createdAt: 1,
    }).run();

    db.insert(extractions).values({
      id: 'e1', userId: 'u1', status: 'pending', createdAt: 1, updatedAt: 1,
    }).run();

    const found = db.select().from(extractions).where(eq(extractions.id, 'e1')).all();
    expect(found).toHaveLength(1);
    expect(found[0]!.status).toBe('pending');
    expect(found[0]!.archiveJobId).toBeNull();
  });

  it('is idempotent — migrating twice does not throw', () => {
    const db = createDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('is idempotent — migrating three times does not throw and does not duplicate the warnings column', () => {
    const db = createDb(':memory:');
    migrate(db);
    migrate(db);
    migrate(db);

    const columns = db.all<{ name: string }>(sql.raw('PRAGMA table_info(extractions)'));
    expect(columns.filter((c) => c.name === 'warnings')).toHaveLength(1);
  });

  it('is idempotent — migrating three times against a legacy database leaves users in the current shape exactly once', () => {
    // migrateUsersTableShape only rebuilds when it finds google_sub or email
    // still present. The 2nd and 3rd calls here must recognize the already-
    // rebuilt table and no-op, rather than attempting (and failing on) a
    // second rebuild of a table that no longer has those columns.
    const db = createDb(':memory:');
    db.run(sql.raw(`CREATE TABLE users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`));
    db.run(sql.raw(`INSERT INTO users VALUES ('u1', 'sub-1', 'a@b.com', 1)`));

    migrate(db);
    migrate(db);
    migrate(db);

    const columns = db.all<{ name: string }>(sql.raw('PRAGMA table_info(users)')).map((c) => c.name);
    expect(columns).toEqual(['id', 'created_at']);

    const rows = db.select().from(users).all();
    expect(rows).toEqual([{ id: 'u1', createdAt: 1 }]);
  });

  it('rebuilds a legacy users table (google_sub/email) into the current shape, preserving the row and every dependent row', () => {
    // This is the migration itself: build the OLD schema by hand -- exactly
    // what an already-deployed database looked like before google_sub/email
    // were dropped -- with a dependent oauth_tokens row and extractions row,
    // then run the real migrate() and prove nothing was lost.
    //
    // Confirmed this test fails against the pre-fix code: with the old
    // migrate() (CREATE TABLE IF NOT EXISTS users includes google_sub/email,
    // and there is no rebuild step), the users row keeps its legacy columns
    // and the `users` Drizzle object -- which no longer declares
    // google_sub/email -- cannot select a row shaped like { id, createdAt }
    // out of it: `found[0]).toEqual({ id: 'legacy-user', createdAt: 1000 })`
    // fails because the real row still carries google_sub and email.
    const db = createDb(':memory:');

    db.run(sql.raw(`CREATE TABLE users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`));
    db.run(sql.raw(`CREATE TABLE oauth_tokens (
       user_id TEXT PRIMARY KEY REFERENCES users(id),
       access_token TEXT NOT NULL,
       refresh_token TEXT,
       expires_at INTEGER NOT NULL,
       scopes TEXT NOT NULL
     )`));
    db.run(sql.raw(`CREATE TABLE extractions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id),
       status TEXT NOT NULL,
       archive_job_id TEXT,
       error TEXT,
       warnings TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`));

    db.run(sql.raw(
      `INSERT INTO users (id, google_sub, email, created_at) ` +
      `VALUES ('legacy-user', 'sub-legacy', 'legacy@example.com', 1000)`,
    ));
    db.run(sql.raw(
      `INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scopes) ` +
      `VALUES ('legacy-user', 'legacy-access', 'legacy-refresh', 999999, 'legacy-scope')`,
    ));
    db.run(sql.raw(
      `INSERT INTO extractions (id, user_id, status, created_at, updated_at) ` +
      `VALUES ('legacy-extraction', 'legacy-user', 'complete', 1000, 1000)`,
    ));

    migrate(db);

    // The users row survived, with its id intact, in the new (reduced) shape.
    const userColumns = db.all<{ name: string }>(sql.raw('PRAGMA table_info(users)')).map((c) => c.name);
    expect(userColumns).toEqual(['id', 'created_at']);

    const userRows = db.select().from(users).where(eq(users.id, 'legacy-user')).all();
    expect(userRows).toHaveLength(1);
    expect(userRows[0]).toEqual({ id: 'legacy-user', createdAt: 1000 });

    // The dependent rows still exist...
    const tokenRows = db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'legacy-user')).all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]!.accessToken).toBe('legacy-access');
    expect(tokenRows[0]!.refreshToken).toBe('legacy-refresh');

    const extractionRows = db.select().from(extractions).where(eq(extractions.userId, 'legacy-user')).all();
    expect(extractionRows).toHaveLength(1);
    expect(extractionRows[0]!.id).toBe('legacy-extraction');

    // ...and still resolve: a real join across the foreign key still works,
    // not just two tables that each happen to still contain a row.
    const joined = db.all<{ id: string }>(sql.raw(
      `SELECT u.id AS id FROM users u JOIN oauth_tokens o ON o.user_id = u.id WHERE u.id = 'legacy-user'`,
    ));
    expect(joined).toEqual([{ id: 'legacy-user' }]);

    // The new shape actually works going forward: a fresh insert through the
    // current schema object succeeds...
    db.insert(users).values({ id: 'fresh-user', createdAt: 2000 }).run();
    expect(db.select().from(users).where(eq(users.id, 'fresh-user')).all()).toHaveLength(1);

    // ...and foreign key enforcement was not silently disabled by the
    // rebuild -- PRAGMA foreign_keys is restored to ON afterward.
    expect(() =>
      db.insert(extractions).values({
        id: 'orphan', userId: 'no-such-user', status: 'pending', createdAt: 1, updatedAt: 1,
      }).run()
    ).toThrow();
  });

  it('rolls back the users table rebuild when a pre-existing orphan foreign key is found, leaving users in the legacy shape', () => {
    // Reproduces the exact scenario the review flagged: a foreign_key_check
    // violation that already exists on disk before migrate() ever runs (a
    // hand-edited row, or damage from some earlier window). If the check ran
    // after the rebuild's transaction committed, this would report the
    // damage but the users table would already be stuck in the new
    // (reduced) shape, having discarded the fact that oauth_tokens still
    // points at a ghost user. The fix moves the check inside the
    // transaction so throwing rolls the whole rebuild back.
    const db = createDb(':memory:');

    db.run(sql.raw(`CREATE TABLE users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`));
    db.run(sql.raw(`CREATE TABLE oauth_tokens (
       user_id TEXT PRIMARY KEY REFERENCES users(id),
       access_token TEXT NOT NULL,
       refresh_token TEXT,
       expires_at INTEGER NOT NULL,
       scopes TEXT NOT NULL
     )`));
    db.run(sql.raw(`CREATE TABLE extractions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id),
       status TEXT NOT NULL,
       archive_job_id TEXT,
       error TEXT,
       warnings TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`));

    db.run(sql.raw(
      `INSERT INTO users (id, google_sub, email, created_at) ` +
      `VALUES ('legacy-user', 'sub-legacy', 'legacy@example.com', 1000)`,
    ));

    // Seed a pre-existing orphan: an oauth_tokens row whose user_id points at
    // no row in users at all. foreign_keys must be OFF to even insert this
    // directly -- createDb() otherwise enforces the constraint immediately --
    // which is exactly how such a row could already be sitting on disk.
    db.run(sql.raw('PRAGMA foreign_keys = OFF'));
    db.run(sql.raw(
      `INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scopes) ` +
      `VALUES ('ghost-user', 'orphan-access', NULL, 999999, 'orphan-scope')`,
    ));
    db.run(sql.raw('PRAGMA foreign_keys = ON'));

    expect(() => migrate(db)).toThrow(/dangling foreign keys/);

    // The rebuild rolled back rather than committing damage: users is still
    // in the legacy (google_sub/email) shape, not the reduced current one.
    const userColumns = db.all<{ name: string }>(sql.raw('PRAGMA table_info(users)')).map((c) => c.name);
    expect(userColumns).toEqual(['id', 'google_sub', 'email', 'created_at']);

    // And the original row -- and the orphan -- are exactly as they were.
    const userRows = db.all<{ id: string }>(sql.raw('SELECT id FROM users'));
    expect(userRows).toEqual([{ id: 'legacy-user' }]);
  });

  // Regression test for a real bug: extractions.warnings was added to
  // schema.ts and to migrate()'s CREATE TABLE, but CREATE TABLE IF NOT
  // EXISTS is a no-op against a database that already has the extractions
  // table -- so every developer who had already run the app before this
  // column was added kept a table with no warnings column, and every
  // subsequent select (drizzle always emits an explicit column list, never
  // SELECT *) failed with "no such column: warnings". This builds that
  // pre-existing, pre-warnings database by hand, then proves the real
  // migrate() reaches it.
  it('adds the warnings column to a database created before it existed', () => {
    const db = createDb(':memory:');

    // The original schema, before extractions.warnings existed -- deliberately
    // NOT calling migrate() here, since that would create the column from the
    // start and defeat the point of this test.
    db.run(`CREATE TABLE users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`);
    db.run(`CREATE TABLE extractions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id),
       status TEXT NOT NULL,
       archive_job_id TEXT,
       error TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`);

    migrate(db);

    // migrate() also rebuilds users out of its old (google_sub/email) shape
    // in the same pass -- this insert proves that combined migration left a
    // table the current schema.ts object can actually write through.
    db.insert(users).values({
      id: 'u7', createdAt: 1,
    }).run();
    db.insert(extractions).values({
      id: 'e7', userId: 'u7', status: 'complete', createdAt: 1, updatedAt: 1,
      warnings: 'Skipped 1 unparseable file(s): bad.json (Unexpected token)',
    }).run();

    const found = db.select().from(extractions).where(eq(extractions.id, 'e7')).all();
    expect(found).toHaveLength(1);
    expect(found[0]!.warnings).toBe('Skipped 1 unparseable file(s): bad.json (Unexpected token)');
  });

  it('enforces foreign keys — inserting an extraction for a nonexistent user throws', () => {
    const db = createDb(':memory:');
    migrate(db);

    expect(() =>
      db.insert(extractions).values({
        id: 'e-orphan', userId: 'no-such-user', status: 'pending', createdAt: 1, updatedAt: 1,
      }).run()
    ).toThrow();
  });

  // The Drizzle table objects in schema.ts and the raw DDL in migrate() are
  // two independent declarations of the same schema. A column renamed,
  // retyped, or dropped in one but not the other would still pass the tests
  // above (they only ever touch users/extractions), so every table gets its
  // own round-trip here: insert through the Drizzle object (which supplies
  // the column names), select back from the real DDL-created table.
  it('round-trips an oauth_tokens row, including a null refresh_token', () => {
    const db = createDb(':memory:');
    migrate(db);

    db.insert(users).values({
      id: 'u2', createdAt: 1,
    }).run();

    db.insert(oauthTokens).values({
      userId: 'u2',
      accessToken: 'access-abc',
      refreshToken: null,
      expiresAt: 999,
      scopes: 'https://www.googleapis.com/auth/dataportability.saved_places',
    }).run();

    const found = db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'u2')).all();
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      userId: 'u2',
      accessToken: 'access-abc',
      refreshToken: null,
      expiresAt: 999,
      scopes: 'https://www.googleapis.com/auth/dataportability.saved_places',
    });
  });

  it('round-trips a raw_artifacts row, including the blob column', () => {
    const db = createDb(':memory:');
    migrate(db);

    db.insert(users).values({
      id: 'u3', createdAt: 1,
    }).run();
    db.insert(extractions).values({
      id: 'e3', userId: 'u3', status: 'complete', createdAt: 1, updatedAt: 1,
    }).run();

    const content = Buffer.from('sourceId,title\nabc,Tatte Bakery\n', 'utf-8');
    db.insert(rawArtifacts).values({
      id: 'a1', extractionId: 'e3', path: 'Takeout/Maps/starred-places.csv', content,
    }).run();

    const found = db.select().from(rawArtifacts).where(eq(rawArtifacts.id, 'a1')).all();
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe('Takeout/Maps/starred-places.csv');
    expect(Buffer.isBuffer(found[0]!.content)).toBe(true);
    expect((found[0]!.content as Buffer).equals(content)).toBe(true);
  });

  it('round-trips a places row and deep-equals a nested JSON payload', () => {
    const db = createDb(':memory:');
    migrate(db);

    db.insert(users).values({
      id: 'u4', createdAt: 1,
    }).run();
    db.insert(extractions).values({
      id: 'e4', userId: 'u4', status: 'complete', createdAt: 1, updatedAt: 1,
    }).run();

    const payload: ResolvedPlace = {
      placeId: 'ChIJ-example-place-id',
      name: 'Tatte Bakery',
      address: '123 Main St, Boston, MA',
      city: 'Boston',
      country: 'United States',
      countryCode: 'US',
      category: 'Food & Drink',
      primaryType: 'bakery',
      lat: 42.35,
      lng: -71.05,
      sourceLists: ['Want to go', 'Starred places'],
      mapsUrl: 'https://maps.google.com/?cid=123',
      note: 'good coffee',
      resolved: true,
    };

    db.insert(places).values({ id: 'p1', extractionId: 'e4', payload }).run();

    const found = db.select().from(places).where(eq(places.id, 'p1')).all();
    expect(found).toHaveLength(1);
    expect(typeof found[0]!.payload).toBe('object');
    expect(found[0]!.payload).toEqual(payload);
  });

  it('round-trips a warnings value on extractions, including null when there were none', () => {
    // extractions.warnings is declared twice (schema.ts and migrate()'s raw
    // DDL) like every other column here -- a mismatch between the two would
    // still pass every other test in this file, since none of them touch it.
    const db = createDb(':memory:');
    migrate(db);

    db.insert(users).values({
      id: 'u5', createdAt: 1,
    }).run();

    db.insert(extractions).values({
      id: 'e5', userId: 'u5', status: 'complete', createdAt: 1, updatedAt: 1,
      warnings: 'Skipped 1 unparseable file(s): bad.json (Unexpected token)',
    }).run();
    db.insert(extractions).values({
      id: 'e6', userId: 'u5', status: 'complete', createdAt: 1, updatedAt: 1,
    }).run();

    const withWarnings = db.select().from(extractions).where(eq(extractions.id, 'e5')).all();
    expect(withWarnings[0]!.warnings).toBe('Skipped 1 unparseable file(s): bad.json (Unexpected token)');

    const withoutWarnings = db.select().from(extractions).where(eq(extractions.id, 'e6')).all();
    expect(withoutWarnings[0]!.warnings).toBeNull();
  });

  it('round-trips an oauth_states row', () => {
    const db = createDb(':memory:');
    migrate(db);

    db.insert(oauthStates).values({ state: 'abc123', createdAt: 1 }).run();

    const found = db.select().from(oauthStates).where(eq(oauthStates.state, 'abc123')).all();
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ state: 'abc123', createdAt: 1 });
  });
});
