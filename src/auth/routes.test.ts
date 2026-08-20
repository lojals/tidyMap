import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { authRoutes } from './routes.js';
import { createAuthState } from './oauth.js';
import { SESSION_COOKIE } from './identity.js';
import { createDb, migrate } from '../db/client.js';
import { users, oauthTokens, oauthStates } from '../db/schema.js';
import { loadConfig } from '../config.js';

const config = loadConfig({
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
});

function buildApp() {
  const db = createDb(':memory:');
  migrate(db);
  return { db };
}

async function buildServer(db: ReturnType<typeof createDb>) {
  const app = Fastify();
  // Registered so the callback's reply.setCookie(...) and identityFrom's
  // request.cookies parsing exercise the real @fastify/cookie mechanism,
  // matching how src/server.ts wires it in production -- a bare Fastify
  // instance has no setCookie/cookies support at all.
  await app.register(cookie);
  await authRoutes(app, { db, config });
  return app;
}

function tokenResponse(): Response {
  // No id_token: Portability-only consent never yields one -- see
  // src/auth/oauth.ts.
  return new Response(JSON.stringify({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/dataportability.saved.collections https://www.googleapis.com/auth/dataportability.maps.starred_places',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  // routes.ts calls exchangeCode/getValidAccessToken/resetAuthorization
  // without passing deps through, so they all fall back to globalThis.fetch.
  // Stubbing that global (rather than mocking the oauth/portability modules)
  // is the only way to intercept the network call while exercising the real
  // route handlers end to end, so it must be cleaned up after every test.
  vi.unstubAllGlobals();
});

describe('authRoutes', () => {
  it('GET /auth/google redirects with a state param, and a second call yields a different one', async () => {
    const { db } = buildApp();
    const app = await buildServer(db);

    const first = await app.inject({ method: 'GET', url: '/auth/google' });
    const second = await app.inject({ method: 'GET', url: '/auth/google' });

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    const firstState = new URL(first.headers.location as string).searchParams.get('state');
    const secondState = new URL(second.headers.location as string).searchParams.get('state');
    expect(firstState).toBeTruthy();
    expect(secondState).toBeTruthy();
    expect(firstState).not.toBe(secondState);
  });

  it('reports denied consent when error is present, even without a code or state', async () => {
    const { db } = buildApp();
    const app = await buildServer(db);

    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Consent was denied: access_denied' });
  });

  it('returns 400 and never calls fetch when state is missing', async () => {
    const { db } = buildApp();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=auth-code',
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown state', async () => {
    const { db } = buildApp();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=auth-code&state=never-issued',
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an expired state', async () => {
    const { db } = buildApp();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const staleState = 'stale-state';
    db.insert(oauthStates).values({
      state: staleState,
      createdAt: Date.now() - 11 * 60 * 1000, // older than the 10-minute TTL
    }).run();

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${staleState}`,
    });

    expect(response.statusCode).toBe(400);
    // Without stubbing fetch above, a TTL regression that let this reach
    // exchangeCode would issue a real outbound call to Google from CI,
    // falsifying the README's "No test calls Google" -- pinned here rather
    // than trusted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400, not 500, when state is repeated in the query string', async () => {
    // Fastify does not schema-validate this querystring, so ?state=a&state=b
    // parses to a string[] at runtime. Before the typeof guard, that array
    // reached a Drizzle eq() filter and better-sqlite3 threw "Too many
    // parameter values were provided", surfacing as an unhandled 500.
    const { db } = buildApp();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=a&state=b',
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is single-use — replaying the same state returns 400 the second time', async () => {
    const { db } = buildApp();
    const state = createAuthState(db);

    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const url = `/auth/google/callback?code=auth-code&state=${state}`;

    const first = await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });

    // First use succeeds (redirect); the state is consumed, so the replay fails.
    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(400);
  });

  it('proceeds to the exchange when the state is valid', async () => {
    const { db } = buildApp();
    const state = createAuthState(db);

    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${state}`,
    });

    // The callback now redirects into the app with the userId in a cookie
    // (see the dedicated cookie test below) rather than returning JSON, so
    // this test's job is narrower: confirm a valid state actually reaches
    // the exchange, exactly once.
    expect(response.statusCode).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets a session cookie and redirects to / instead of returning JSON', async () => {
    const { db } = buildApp();
    const state = createAuthState(db);

    // Without stubbing fetch, exchangeCode would issue a real outbound call
    // to Google -- see the TTL test above for why that invariant matters.
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'GET', url: `/auth/google/callback?code=abc&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    // SameSite=Lax is what stops a cross-site POST to the unauthenticated,
    // destructive /auth/reset once a cookie carries identity. A bare
    // 'SameSite' substring would also match 'SameSite=None', so the
    // assertion pins the full attribute pair.
    expect(setCookie).toContain('SameSite=Lax');

    // A substring check for the cookie name alone passes for any value --
    // pin it to the actual userId persistTokens inserted (the sole row in
    // `users`), not merely to the cookie's presence.
    const insertedUsers = db.select().from(users).all();
    expect(insertedUsers).toHaveLength(1);

    const value = setCookie.split(';')[0]!.split('=')[1];
    expect(value).toBe(insertedUsers[0]!.id);
  });

  it('returns 400 for a missing code when the state is valid and there is no error', async () => {
    const { db } = buildApp();
    const state = createAuthState(db);
    const app = await buildServer(db);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing authorization code.' });
  });

  it('POST /auth/reset with no body returns 400 rather than throwing on request.body.userId', async () => {
    const { db } = buildApp();
    const app = await buildServer(db);

    const response = await app.inject({ method: 'POST', url: '/auth/reset' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'userId is required.' });
  });

  it('POST /auth/reset resets authorization using the access token for that user', async () => {
    const { db } = buildApp();
    db.insert(users).values({ id: 'u1', createdAt: 0 }).run();
    db.insert(oauthTokens).values({
      userId: 'u1',
      accessToken: 'valid-access-token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 600_000, // not expired: getValidAccessToken returns it without calling fetch
      scopes: '',
    }).run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildServer(db);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { userId: 'u1' },
    });

    expect(response.statusCode).toBe(200);
    // The stored token is not expired, so the only fetch call is resetAuthorization's.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://dataportability.googleapis.com/v1/authorization:reset');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer valid-access-token' });
  });
});
