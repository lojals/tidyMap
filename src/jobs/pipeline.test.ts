import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runExtraction } from './pipeline.js';
import { createDb, migrate, type Db } from '../db/client.js';
import { users, extractions, places, oauthTokens } from '../db/schema.js';
import { loadConfig } from '../config.js';

function ctxWith(source: 'live' | 'fixture', extraEnv: Record<string, string> = {}) {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', googleSub: 's', email: 'a@b.com', createdAt: 0 }).run();
  db.insert(extractions).values({
    id: 'e1', userId: 'u1', status: 'pending', createdAt: 0, updatedAt: 0,
  }).run();

  const config = loadConfig({
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
    PORTABILITY_SOURCE: source,
    ...extraEnv,
  });
  return { db, config };
}

/** Stores a valid, non-expiring access token so getValidAccessToken need not refresh. */
function withStoredToken(db: Db): void {
  db.insert(oauthTokens).values({
    userId: 'u1',
    accessToken: 'live-access-token',
    refreshToken: null,
    expiresAt: Date.now() + 10_000_000,
    scopes: 'openid',
  }).run();
}

const placesOk = new Response(JSON.stringify({
  places: [{
    id: 'ChIJfixture',
    displayName: { text: 'Fixture Cafe' },
    primaryType: 'cafe',
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

const placesNoMatch = new Response(JSON.stringify({ places: [] }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

const noSleep = async () => {};

describe('runExtraction in fixture mode', () => {
  it('completes without calling the Portability API and stores places', async () => {
    const ctx = ctxWith('fixture');
    // The fixtures contain several distinct places, so enrich() makes more
    // than one Places call. mockResolvedValue would hand back the SAME
    // cloned Response object every time, and a Response body can only be
    // read once -- the second .json() call would throw "Body is unusable:
    // Body has already been read". mockImplementation clones fresh per call.
    const fetch = vi.fn().mockImplementation(async () => placesOk.clone());

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');

    const stored = ctx.db.select().from(places).where(eq(places.extractionId, 'e1')).all();
    expect(stored.length).toBeGreaterThan(0);

    for (const call of fetch.mock.calls) {
      expect(call[0]).not.toContain('dataportability.googleapis.com');
    }
  });

  it('marks the extraction failed and records the reason when Places throws', async () => {
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/403/);
  });

  it('applies the cap before enrichment, so Places is never called for items beyond it', async () => {
    // The fixture export carries 5 place-bearing items (2 starred + 3 from
    // the collection). A row-count assertion alone cannot tell "capped at 2,
    // then enriched" apart from "enriched all 5, deduped down to 2" -- so
    // this asserts the number of paid Places calls directly.
    const ctx = ctxWith('fixture', { EXTRACTION_LIMIT: '2' });
    const fetch = vi.fn().mockImplementation(async () => placesOk.clone());

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');
    expect(fetch.mock.calls.length).toBe(2);
  });

  it('persists unresolved places instead of dropping them', async () => {
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockImplementation(async () => placesNoMatch.clone());

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');

    const stored = ctx.db.select().from(places).where(eq(places.extractionId, 'e1')).all();
    // Nothing has a placeId to merge on, so all 5 fixture items are kept
    // (none are dropped and none are silently deduped away).
    expect(stored.length).toBe(5);
    for (const row of stored) {
      expect((row.payload as { resolved: boolean; placeId: string | null }).resolved).toBe(false);
      expect((row.payload as { resolved: boolean; placeId: string | null }).placeId).toBeNull();
    }
  });

  it('never rejects, even when writing the failure status itself throws', async () => {
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Break the DB write the catch block relies on to record the failure,
    // simulating e.g. a closed connection or a disk-full error at the exact
    // moment the pipeline tries to report that something else went wrong.
    // The 1st update() call is the initial "running" status write (which
    // must succeed so the scenario is realistic); the 2nd is the catch
    // block's "failed" write, which this makes throw.
    let updateCallCount = 0;
    const originalUpdate = ctx.db.update.bind(ctx.db);
    ctx.db.update = ((...args: Parameters<typeof originalUpdate>) => {
      updateCallCount++;
      if (updateCallCount === 2) {
        throw new Error('simulated disk failure while recording status');
      }
      return originalUpdate(...args);
    }) as typeof ctx.db.update;

    await expect(runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep }))
      .resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('runExtraction in live mode', () => {
  it('times out, keeps the archiveJobId, and marks the extraction timed_out', async () => {
    // Re-initiating an archive burns the one-time Portability consent, so a
    // stalled job must stay resumable: the archiveJobId recorded once the
    // job was initiated must survive a poll timeout untouched.
    const ctx = ctxWith('live', { EXTRACTION_LIMIT: '20' });
    withStoredToken(ctx.db);

    const fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('portabilityArchive:initiate')) {
        return new Response(JSON.stringify({ archiveJobId: 'job-1', accessType: 'ACCESS_TYPE_ONE_TIME' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (href.includes('portabilityArchiveState')) {
        return new Response(JSON.stringify({ state: 'IN_PROGRESS' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${href}`);
    });

    // A fake clock: sleep() advances it instead of the test actually
    // waiting, and now() reads from it, so the 15-minute-scale deadline
    // resolves in real time without the test taking any wall-clock time.
    let clock = 0;
    const fakeNow = () => clock;
    const fastForward = async (ms: number) => { clock += ms; };

    await runExtraction('e1', 'u1', ctx, {
      fetch: fetch as never,
      sleep: fastForward,
      now: fakeNow,
      pollTimeoutMs: 60_000,
    });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('timed_out');
    expect(row.archiveJobId).toBe('job-1');
  });
});
