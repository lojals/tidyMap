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
      id: 'u1', googleSub: 'sub-1', email: 'a@b.com', createdAt: 1,
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

    db.insert(users).values({
      id: 'u7', googleSub: 'sub-7', email: 'g@h.com', createdAt: 1,
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
      id: 'u2', googleSub: 'sub-2', email: 'b@c.com', createdAt: 1,
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
      id: 'u3', googleSub: 'sub-3', email: 'c@d.com', createdAt: 1,
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
      id: 'u4', googleSub: 'sub-4', email: 'd@e.com', createdAt: 1,
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
      id: 'u5', googleSub: 'sub-5', email: 'e@f.com', createdAt: 1,
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
