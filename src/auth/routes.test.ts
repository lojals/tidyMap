import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { authRoutes } from './routes.js';
import { buildAuthUrl } from './oauth.js';
import { createDb, migrate } from '../db/client.js';
import { users, oauthTokens } from '../db/schema.js';
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

afterEach(() => {
  // routes.ts calls exchangeCode/getValidAccessToken/resetAuthorization
  // without passing deps through, so they all fall back to globalThis.fetch.
  // Stubbing that global (rather than mocking the oauth/portability modules)
  // is the only way to intercept the network call while exercising the real
  // route handlers end to end, so it must be cleaned up after every test.
  vi.unstubAllGlobals();
});

describe('authRoutes', () => {
  it('GET /auth/google redirects to the Google auth URL', async () => {
    const { db } = buildApp();
    const app = await buildServer(db);

    const response = await app.inject({ method: 'GET', url: '/auth/google' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(buildAuthUrl(config));
  });

  it('reports denied consent when error is present, even without a code', async () => {
    const { db } = buildApp();
    const app = await buildServer(db);

    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Consent was denied: access_denied' });
  });

  it('returns 400 for a missing code when there is no error either', async () => {
    const { db } = buildApp();
    const app = await buildServer(db);

    const response = await app.inject({ method: 'GET', url: '/auth/google/callback' });

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
