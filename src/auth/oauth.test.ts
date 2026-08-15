import { describe, it, expect, vi } from 'vitest';
import { buildAuthUrl, getValidAccessToken, persistTokens } from './oauth.js';
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
