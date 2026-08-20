import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildServer } from '../server.js';
import { createDb, migrate } from '../db/client.js';
import { users, extractions } from '../db/schema.js';
import { loadConfig } from '../config.js';
import type { GroupedResult, ResolvedPlace } from '../domain/types.js';

const placesOk = () => new Response(JSON.stringify({
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

function buildTestServer() {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', createdAt: 0 }).run();

  const config = loadConfig({
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
    PORTABILITY_SOURCE: 'fixture',
  });

  // awaitPipeline makes the request/response cycle deterministic in tests.
  const app = buildServer({ db, config }, {
    awaitPipeline: true,
    fetch: vi.fn().mockImplementation(async () => placesOk()) as never,
    sleep: async () => {},
  });

  return { app, db };
}

async function startExtraction(app: ReturnType<typeof buildTestServer>['app']) {
  const created = await app.inject({
    method: 'POST', url: '/extractions', payload: { userId: 'u1' },
  });
  return created;
}

describe('extraction endpoints', () => {
  it('creates an extraction and reports completion, then returns grouped results', async () => {
    const { app } = buildTestServer();

    const created = await startExtraction(app);
    expect(created.statusCode).toBe(202);
    const createdBody = created.json<{ jobId: string; status: string }>();
    expect(createdBody.jobId).toBeTruthy();
    expect(createdBody.status).toBe('pending');

    const status = await app.inject({ method: 'GET', url: `/extractions/${createdBody.jobId}` });
    expect(status.json<{ status: string }>().status).toBe('complete');

    const results = await app.inject({ method: 'GET', url: `/extractions/${createdBody.jobId}/results` });
    const body = results.json<GroupedResult>();
    expect(body.groupBy).toBe('category');
    expect(body.totalPlaces).toBeGreaterThan(0);
    expect(body.unresolvedCount).toBe(0);
    expect(body.results[0]!['category']).toBe('Food & Drink');
    expect((body.results[0]!['places'] as ResolvedPlace[])[0]!.placeId).toBe('ChIJfixture');
  });

  it('defaults groupBy to category and honours an explicit dimension', async () => {
    const { app } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    const byCity = await app.inject({
      method: 'GET', url: `/extractions/${jobId}/results?groupBy=city`,
    });
    expect(byCity.json<GroupedResult>().groupBy).toBe('city');
    expect(byCity.json<GroupedResult>().results[0]!['city']).toBe('Barcelona');

    const byCountry = await app.inject({
      method: 'GET', url: `/extractions/${jobId}/results?groupBy=country`,
    });
    expect(byCountry.json<GroupedResult>().groupBy).toBe('country');
    expect(byCountry.json<GroupedResult>().results[0]!['country']).toBe('Spain');
  });

  it('rejects an unknown groupBy with 400', async () => {
    const { app } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    const bad = await app.inject({
      method: 'GET', url: `/extractions/${jobId}/results?groupBy=vibes`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns 404 for an unknown extraction', async () => {
    const { app } = buildTestServer();
    expect((await app.inject({ method: 'GET', url: '/extractions/nope' })).statusCode).toBe(404);
  });

  it('returns 409 when results are requested before the job completes', async () => {
    const { app, db } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    db.update(extractions).set({ status: 'running' }).where(eq(extractions.id, jobId)).run();

    const early = await app.inject({ method: 'GET', url: `/extractions/${jobId}/results` });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ status: string }>().status).toBe('running');
  });

  it('reports warnings as null on GET /extractions/:jobId when nothing was skipped or unmapped', async () => {
    const { app } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    const status = await app.inject({ method: 'GET', url: `/extractions/${jobId}` });
    expect(status.json<{ warnings: string | null }>().warnings).toBeNull();
  });

  it('returns 400 for an unknown userId', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'POST', url: '/extractions', payload: { userId: 'ghost' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts identity from the session cookie with no body userId', async () => {
    const { app } = buildTestServer();
    const created = await app.inject({
      method: 'POST', url: '/extractions',
      cookies: { tidymap_uid: 'u1' },
      payload: {},
    });
    expect(created.statusCode).toBe(202);
  });

  it('prefers the cookie over a body userId when both are present', async () => {
    const { app, db } = buildTestServer();
    db.insert(users).values({ id: 'u2', createdAt: 0 }).run();

    const created = await app.inject({
      method: 'POST', url: '/extractions',
      cookies: { tidymap_uid: 'u1' },
      payload: { userId: 'u2' },
    });

    const { jobId } = created.json<{ jobId: string }>();
    const row = db.select().from(extractions).where(eq(extractions.id, jobId)).all()[0]!;
    expect(row.userId).toBe('u1');
  });
});
