import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from './routes.js';
import { createAuthState } from './oauth.js';
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
  await authRoutes(app, { db, config });
  return app;
}

/**
 * Builds a fake (unsigned) ID token: header.payload.signature, where the
 * payload is the base64url encoding of the given JSON claims. decodeIdToken
 * only ever reads the payload segment, so the header/signature values are
 * arbitrary placeholders — never a real Google-issued token.
 */
function fakeIdToken(payload: { sub: string; email: string }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: 'openid email',
    id_token: fakeIdToken({ sub: 'sub-1', email: 'user@example.com' }),
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

    expect(first.statusCode).toBe(200);
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

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: 'user@example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('POST /auth/reset resets authorization using the access token for that user', async () => {
    const { db } = buildApp();
    db.insert(users).values({ id: 'u1', googleSub: 's', email: 'a@b.com', createdAt: 0 }).run();
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
