import { describe, it, expect, vi } from 'vitest';
import { buildAuthUrl, exchangeCode, getValidAccessToken, persistTokens } from './oauth.js';
import { createDb, migrate } from '../db/client.js';
import { users, oauthTokens } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';

const config = loadConfig({
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
});

function seedDb(expiresAt: number, refreshToken: string | null) {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', googleSub: 's', email: 'a@b.com', createdAt: 0 }).run();
  db.insert(oauthTokens).values({
    userId: 'u1', accessToken: 'old-token', refreshToken, expiresAt, scopes: '',
  }).run();
  return db;
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

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildAuthUrl', () => {
  it('requests both portability scopes plus openid and email', () => {
    const url = new URL(buildAuthUrl(config));
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/dataportability.saved.collections');
    expect(scopes).toContain('https://www.googleapis.com/auth/dataportability.maps.starred_places');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
  });

  it('requests offline access and forces the consent prompt', () => {
    const url = new URL(buildAuthUrl(config));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('exchangeCode', () => {
  it('posts the authorization_code grant to the token endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      expires_in: 3600,
      scope: 'openid email',
      id_token: fakeIdToken({ sub: 'sub-1', email: 'user@example.com' }),
    }));

    await exchangeCode('auth-code', config, { fetch: fetch as never });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = Object.fromEntries(new URLSearchParams(init.body));
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: config.google.redirectUri,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
    });
  });

  it('sets refreshToken to null when the response omits refresh_token', async () => {
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      expires_in: 3600,
      scope: 'openid email',
      id_token: fakeIdToken({ sub: 'sub-1', email: 'user@example.com' }),
    }));

    const tokens = await exchangeCode('auth-code', config, { fetch: fetch as never });

    expect(tokens.refreshToken).toBeNull();
  });

  it('computes expiresAt from expires_in', async () => {
    const before = Date.now();
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      expires_in: 3600,
      scope: 'openid email',
      id_token: fakeIdToken({ sub: 'sub-1', email: 'user@example.com' }),
    }));

    const tokens = await exchangeCode('auth-code', config, { fetch: fetch as never });
    const after = Date.now();

    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it('derives googleSub and email from the decoded id_token payload', async () => {
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'openid email',
      id_token: fakeIdToken({ sub: 'sub-42', email: 'someone@example.com' }),
    }));

    const tokens = await exchangeCode('auth-code', config, { fetch: fetch as never });

    expect(tokens.googleSub).toBe('sub-42');
    expect(tokens.email).toBe('someone@example.com');
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.scopes).toBe('openid email');
  });

  it('throws with the status but without the response body when the exchange fails', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('client_secret leaked here', { status: 400 }),
    );

    await expect(exchangeCode('auth-code', config, { fetch: fetch as never }))
      .rejects.toThrow('Token exchange failed with status 400.');
  });
});

describe('getValidAccessToken', () => {
  it('returns the stored token when it has not expired', async () => {
    const db = seedDb(Date.now() + 600_000, 'refresh');
    const fetch = vi.fn();
    const token = await getValidAccessToken(db, 'u1', config, { fetch: fetch as never });
    expect(token).toBe('old-token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes a token that is not yet expired but within the skew window', async () => {
    // 30s out — after the 60s EXPIRY_SKEW_MS, this must be treated as needing
    // a refresh, not "still valid". A naive `expiresAt > Date.now()` check
    // would wrongly return the stale token here.
    const db = seedDb(Date.now() + 30_000, 'refresh');
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'refreshed-in-time', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const token = await getValidAccessToken(db, 'u1', config, { fetch: fetch as never });

    expect(token).toBe('refreshed-in-time');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = Object.fromEntries(new URLSearchParams(init.body));
    expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh' });
  });

  it('refreshes an expired token and persists the new one', async () => {
    const db = seedDb(Date.now() - 1000, 'refresh');
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'new-token', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const token = await getValidAccessToken(db, 'u1', config, { fetch: fetch as never });

    expect(token).toBe('new-token');
    const stored = db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'u1')).all();
    expect(stored[0]!.accessToken).toBe('new-token');

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = Object.fromEntries(new URLSearchParams(init.body));
    expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh' });
  });

  it('throws a re-auth error when the token is expired and no refresh token exists', async () => {
    const db = seedDb(Date.now() - 1000, null);
    await expect(getValidAccessToken(db, 'u1', config, { fetch: vi.fn() as never }))
      .rejects.toThrow(/GET \/auth\/google/);
  });

  it('throws a re-auth error when the refresh is rejected', async () => {
    const db = seedDb(Date.now() - 1000, 'refresh');
    const fetch = vi.fn().mockResolvedValue(new Response('invalid_grant', { status: 400 }));
    await expect(getValidAccessToken(db, 'u1', config, { fetch: fetch as never }))
      .rejects.toThrow(/GET \/auth\/google/);
  });
});

describe('persistTokens', () => {
  it('creates a new user on first auth with an id derived from googleSub', () => {
    const db = createDb(':memory:');
    migrate(db);

    const userId = persistTokens(db, {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 600_000,
      scopes: '',
      googleSub: 'sub-1',
      email: 'new@example.com',
    });

    expect(userId).toBe('user_sub-1');
    const rows = db.select().from(users).where(eq(users.id, 'user_sub-1')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('new@example.com');
    expect(rows[0]!.googleSub).toBe('sub-1');
  });

  it('does not insert a second user row when the same googleSub authorizes twice', () => {
    const db = createDb(':memory:');
    migrate(db);

    const base = {
      expiresAt: Date.now() + 600_000,
      scopes: '',
      googleSub: 'sub-1',
      email: 'new@example.com',
    };

    persistTokens(db, { ...base, accessToken: 'access-1', refreshToken: 'refresh-1' });
    persistTokens(db, { ...base, accessToken: 'access-2', refreshToken: 'refresh-2' });

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(1);
  });

  it('replaces the stored refresh token when re-auth returns a new one', () => {
    const db = seedDb(Date.now() + 600_000, 'old-refresh');

    const userId = persistTokens(db, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 600_000,
      scopes: '',
      googleSub: 's',
      email: 'a@b.com',
    });

    expect(userId).toBe('u1');
    const stored = db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'u1')).all();
    expect(stored[0]!.refreshToken).toBe('new-refresh');
  });

  it('preserves the stored refresh token when re-auth omits one', () => {
    // Google omits refresh_token on most exchanges once offline access has
    // already been granted. If persistTokens overwrote unconditionally, this
    // would null out a working refresh token and force a fresh browser
    // consent on the next expiry — exactly the cost the one-time
    // Portability authorization makes expensive.
    const db = seedDb(Date.now() + 600_000, 'old-refresh');

    persistTokens(db, {
      accessToken: 'new-access',
      refreshToken: null,
      expiresAt: Date.now() + 600_000,
      scopes: '',
      googleSub: 's',
      email: 'a@b.com',
    });

    const stored = db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'u1')).all();
    expect(stored[0]!.refreshToken).toBe('old-refresh');
    expect(stored[0]!.accessToken).toBe('new-access');
  });
});
