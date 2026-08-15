import { describe, it, expect } from 'vitest';
import { createDb, migrate } from './client.js';
import { users, extractions } from './schema.js';
import { eq } from 'drizzle-orm';

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

  it('enforces foreign keys — inserting an extraction for a nonexistent user throws', () => {
    const db = createDb(':memory:');
    migrate(db);

    expect(() =>
      db.insert(extractions).values({
        id: 'e-orphan', userId: 'no-such-user', status: 'pending', createdAt: 1, updatedAt: 1,
      }).run()
    ).toThrow();
  });
});
