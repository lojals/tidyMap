import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runExtraction } from './pipeline.js';
import { loadFixtureExport } from './fixture-source.js';
import { createDb, migrate, type Db } from '../db/client.js';
import { users, extractions, places, rawArtifacts, oauthTokens } from '../db/schema.js';
import { loadConfig } from '../config.js';

function ctxWith(source: 'live' | 'fixture', extraEnv: Record<string, string> = {}) {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', createdAt: 0 }).run();
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

  it('names the failing stage in the recorded error, so a live failure says where it happened', async () => {
    // Before this fix, a thrown error's message alone (e.g. "Cannot read
    // properties of undefined (reading 'includes')") gave no hint of which
    // pipeline stage produced it -- this proves the stored error is prefixed
    // with the stage name regardless of which underlying error occurred.
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^enrich: /);
  });

  it('names the archive stage in the recorded error when the archive job itself fails', async () => {
    // A different stage than enrich, to prove the stage-naming is general
    // (applies to whichever stage actually throws), not hardcoded to enrich.
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
        return new Response(JSON.stringify({ state: 'FAILED' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${href}`);
    });

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('archive: Google reported the archive job as FAILED.');
  });

  it('ends the job failed (not complete) when Places rejects the key with a 400', async () => {
    // Google returns 400 API_KEY_INVALID for a bad key, not 401/403. A unit
    // test on searchText alone would not catch a regression where the
    // pipeline swallows that throw into a completed job with everything
    // unresolved -- this proves the throw actually propagates all the way
    // out of enrich() and runExtraction() to the extraction row.
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', reason: 'API_KEY_INVALID' } }),
      { status: 400 },
    ));

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/GOOGLE_PLACES_API_KEY/);

    const stored = ctx.db.select().from(places).where(eq(places.extractionId, 'e1')).all();
    expect(stored).toHaveLength(0);
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

  it('persists rawArtifacts durably even when a later stage fails, so a parse/enrich bug costs a re-parse, not a re-consent', async () => {
    // parseExport cannot throw in the current implementation -- every parser
    // call it makes is wrapped in its own try/catch (skippedFiles() records
    // the failure per file instead of propagating). So this proves the
    // durability property via the failure path that genuinely does throw
    // inside runExtraction's try block: a Places 403 during enrich(), which
    // happens well after the rawArtifacts inserts have already run and
    // committed (better-sqlite3 autocommits each .run(); nothing here is
    // wrapped in db.transaction()).
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');

    const fixtureFiles = loadFixtureExport();
    const artifacts = ctx.db.select().from(rawArtifacts).where(eq(rawArtifacts.extractionId, 'e1')).all();
    expect(artifacts.length).toBe(fixtureFiles.length);
    for (const file of fixtureFiles) {
      const stored = artifacts.find((a) => a.path === file.path);
      expect(stored).toBeDefined();
      // Byte-for-byte, not just present: a truncated or corrupted copy would
      // defeat the whole point of paying for the download exactly once.
      expect(stored!.content.toString('utf8')).toBe(file.content);
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
    // Wrapped in vi.fn() (rather than a bare async function) so the actual
    // ms arguments it was called with can be inspected below -- a fixed,
    // non-growing interval would reach the same fake-clock deadline and
    // leave the status/archiveJobId assertions alone, so those two checks
    // cannot catch a regressed backoff on their own.
    let clock = 0;
    const fakeNow = () => clock;
    const fastForward = vi.fn(async (ms: number) => { clock += ms; });

    await runExtraction('e1', 'u1', ctx, {
      fetch: fetch as never,
      sleep: fastForward,
      now: fakeNow,
      pollTimeoutMs: 60_000,
    });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('timed_out');
    expect(row.archiveJobId).toBe('job-1');

    // Math.min(2 ** attempt * 2000, 30_000): 2000, 4000, 8000, 16000, then
    // capped at 30000 for every attempt after. Pin both the growth and the
    // cap, not just the final outcome, so a flattened or uncapped backoff
    // fails here even though it would still time out at the same status.
    const sleptMs = fastForward.mock.calls.map((call) => call[0]);
    expect(sleptMs.slice(0, 4)).toEqual([2000, 4000, 8000, 16000]);
    expect(Math.max(...sleptMs)).toBe(30_000);
    for (let i = 1; i < sleptMs.length; i++) {
      expect(sleptMs[i]).toBeGreaterThanOrEqual(sleptMs[i - 1]!);
    }
  });
});

describe('runExtraction warnings', () => {
  // skippedFiles()/unmappedTypeCounts() are process-global registries that
  // nothing outside tests read unless the pipeline surfaces them: before this
  // fix, a corrupt export file was recorded there and then never seen by
  // anyone -- the job still reported `complete` with the place from that file
  // simply gone, with no signal. These prove the values actually reach
  // extractions.warnings, not just the registries themselves (already
  // covered by src/parse/index.test.ts and src/categorize/taxonomy.test.ts).

  function archiveFetch(files: Record<string, string>) {
    return vi.fn().mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('portabilityArchive:initiate')) {
        return new Response(JSON.stringify({ archiveJobId: 'job-1', accessType: 'ACCESS_TYPE_ONE_TIME' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (href.includes('portabilityArchiveState')) {
        return new Response(JSON.stringify({
          state: 'COMPLETE',
          urls: Object.keys(files).map((name) => `https://signed/${name}`),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      for (const [name, content] of Object.entries(files)) {
        if (href === `https://signed/${name}`) return new Response(content, { status: 200 });
      }
      if (href.includes('places:searchText')) return placesOk.clone();
      throw new Error(`unexpected fetch to ${href}`);
    });
  }

  it('completes, persists places from the other files, and reports a skipped unparseable file in warnings', async () => {
    const ctx = ctxWith('live', { EXTRACTION_LIMIT: '20' });
    withStoredToken(ctx.db);

    const fetch = archiveFetch({
      'good.csv': 'title,item_content_url\nGood Place,https://www.google.com/maps/place/Good/\n',
      'bad.json': '{ not json at all',
    });

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');
    expect(row.warnings).toContain('bad.json');

    const stored = ctx.db.select().from(places).where(eq(places.extractionId, 'e1')).all();
    expect(stored.length).toBe(1);
    expect((stored[0]!.payload as { name: string }).name).toBe('Fixture Cafe');
  });

  it('leaves warnings null when nothing was skipped or unmapped', async () => {
    const ctx = ctxWith('live', { EXTRACTION_LIMIT: '20' });
    withStoredToken(ctx.db);

    const fetch = archiveFetch({
      'good.csv': 'title,item_content_url\nGood Place,https://www.google.com/maps/place/Good/\n',
    });

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');
    expect(row.warnings).toBeNull();
  });

  it('ends failed with the skipped file named in warnings and the failure reason still in error', async () => {
    // Before this fix, summarizeWarnings only ran on the success path, so a
    // run that skipped a corrupt file and then failed reported nothing about
    // the skip -- exactly the run where that context matters most. This
    // combines both: bad.json is skipped during parse (recorded in the
    // process-global skippedFiles registry), then the Places call 403s,
    // which throws and lands in runExtraction's catch block.
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
        return new Response(JSON.stringify({
          state: 'COMPLETE',
          urls: ['https://signed/good.csv', 'https://signed/bad.json'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === 'https://signed/good.csv') {
        return new Response('title,item_content_url\nGood Place,https://www.google.com/maps/place/Good/\n', { status: 200 });
      }
      if (href === 'https://signed/bad.json') {
        return new Response('{ not json at all', { status: 200 });
      }
      if (href.includes('places:searchText')) {
        return new Response('denied', { status: 403 });
      }
      throw new Error(`unexpected fetch to ${href}`);
    });

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/403/);
    expect(row.warnings).toContain('bad.json');
  });

  it('reports an unmapped primaryType in warnings', async () => {
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
        return new Response(JSON.stringify({
          state: 'COMPLETE', urls: ['https://signed/good.csv'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === 'https://signed/good.csv') {
        return new Response('title,item_content_url\nGood Place,https://www.google.com/maps/place/Good/\n', { status: 200 });
      }
      if (href.includes('places:searchText')) {
        return new Response(JSON.stringify({
          places: [{
            id: 'ChIJweird', displayName: { text: 'Weird Place' }, primaryType: 'flying_saucer_dealership',
            addressComponents: [
              { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
              { longText: 'Spain', shortText: 'ES', types: ['country'] },
            ],
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch to ${href}`);
    });

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');
    expect(row.warnings).toContain('flying_saucer_dealership');
  });
});
