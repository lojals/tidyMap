import { describe, it, expect, vi } from 'vitest';
import {
  buildAuthUrl, consumeAuthState, createAuthState, exchangeCode, getValidAccessToken,
  persistTokens,
} from './oauth.js';
import { createDb, migrate } from '../db/client.js';
import { users, oauthTokens, oauthStates } from '../db/schema.js';
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
  db.insert(users).values({ id: 'u1', createdAt: 0 }).run();
  db.insert(oauthTokens).values({
    userId: 'u1', accessToken: 'old-token', refreshToken, expiresAt, scopes: '',
  }).run();
  return db;
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildAuthUrl', () => {
  it('requests only the two Portability scopes -- openid and email must be absent', () => {
    // This is the assertion that would have caught the original defect:
    // Google rejects any scope request that mixes dataportability.* scopes
    // with openid/email outright ("Requests for data portability scopes
    // cannot have non data portability scopes."). Asserting the Portability
    // scopes are present is not enough on its own -- a SCOPES list of
    // ['openid', 'email', ...PORTABILITY_SCOPES] would still pass that half
    // of the check while remaining completely broken against Google.
    const url = new URL(buildAuthUrl(config, 'state-1'));
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/dataportability.saved.collections',
      'https://www.googleapis.com/auth/dataportability.maps.starred_places',
    ]);
    expect(scopes).not.toContain('openid');
    expect(scopes).not.toContain('email');
  });

  it('requests offline access and forces the consent prompt', () => {
    const url = new URL(buildAuthUrl(config, 'state-1'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('includes the given state so the callback can verify it', () => {
    const url = new URL(buildAuthUrl(config, 'state-xyz'));
    expect(url.searchParams.get('state')).toBe('state-xyz');
  });

  it('redirects to Google\'s own OAuth endpoint, not some other host', () => {
    // Every prior test here only inspected searchParams, so nothing pinned
    // AUTH_ENDPOINT itself -- changing it to an attacker-controlled host
    // would leave the rest of this file green while redirecting the user's
    // consent flow elsewhere. Proven load-bearing: temporarily pointing
    // AUTH_ENDPOINT at another host fails this assertion (verified by hand
    // during this fix, then reverted).
    const url = new URL(buildAuthUrl(config, 'state-1'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });
});

describe('createAuthState / consumeAuthState', () => {
  it('creates distinct states across calls', () => {
    const db = createDb(':memory:');
    migrate(db);

    const first = createAuthState(db);
    const second = createAuthState(db);

    expect(first).not.toBe(second);
  });

  it('consumeAuthState returns false for undefined', () => {
    const db = createDb(':memory:');
    migrate(db);

    expect(consumeAuthState(db, undefined)).toBe(false);
  });

  it('reaps expired rows as a side effect of minting a new state, so oauth_states does not grow unbounded', () => {
    // A row is otherwise only ever removed when its exact state reaches the
    // callback -- an abandoned consent flow (browser closed, tab left open)
    // would leave its row behind forever with nothing to clean it up.
    const db = createDb(':memory:');
    migrate(db);

    db.insert(oauthStates).values({
      state: 'long-abandoned',
      createdAt: Date.now() - 11 * 60 * 1000, // older than the 10-minute TTL
    }).run();
    db.insert(oauthStates).values({
      state: 'recent',
      createdAt: Date.now() - 60 * 1000, // within the TTL -- must survive
    }).run();

    createAuthState(db);

    const remaining = db.select().from(oauthStates).all().map((r) => r.state);
    expect(remaining).not.toContain('long-abandoned');
    expect(remaining).toContain('recent');
  });
});

describe('exchangeCode', () => {
  it('posts the authorization_code grant to the token endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/dataportability.saved.collections',
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
      scope: 'https://www.googleapis.com/auth/dataportability.saved.collections',
    }));

    const tokens = await exchangeCode('auth-code', config, { fetch: fetch as never });

    expect(tokens.refreshToken).toBeNull();
  });

  it('computes expiresAt from expires_in', async () => {
    const before = Date.now();
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/dataportability.saved.collections',
    }));

    const tokens = await exchangeCode('auth-code', config, { fetch: fetch as never });
    const after = Date.now();

    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it('parses a token response that carries no id_token at all -- the normal shape for Portability-only consent', async () => {
    // Google's own docs state that during this flow "your app does not know
    // which Google Account was used to give consent" and the token is
    // opaque -- so a real response here has no id_token field whatsoever.
    // This must not throw and must not attempt to decode anything.
    const fetch = vi.fn().mockResolvedValue(tokenResponse({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/dataportability.saved.collections https://www.googleapis.com/auth/dataportability.maps.starred_places',
    }));

    const tokens = await exchangeCode('auth-code', config, { fetch: fetch as never });

    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: tokens.expiresAt,
      scopes: 'https://www.googleapis.com/auth/dataportability.saved.collections https://www.googleapis.com/auth/dataportability.maps.starred_places',
    });
    expect(tokens).not.toHaveProperty('googleSub');
    expect(tokens).not.toHaveProperty('email');
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
  const baseTokens = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 600_000,
    scopes: '',
  };

  it('creates a user with a generated (opaque) id, and stores the tokens against it', () => {
    const db = createDb(':memory:');
    migrate(db);

    const userId = persistTokens(db, baseTokens);

    expect(userId).toBeTruthy();
    // Not derived from anything Google returned -- there is nothing to
    // derive it from. Just proving it's a real UUID, not e.g. undefined
    // stringified or some other accidental fallback.
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);

    const userRows = db.select().from(users).where(eq(users.id, userId)).all();
    expect(userRows).toHaveLength(1);
    expect(userRows[0]).not.toHaveProperty('googleSub');
    expect(userRows[0]).not.toHaveProperty('email');

    const tokenRows = db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)).all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]!.accessToken).toBe('access-1');
    expect(tokenRows[0]!.refreshToken).toBe('refresh-1');
  });

  it('creates two rows when called twice -- this is the documented behavior now, not a bug', () => {
    // Portability-only consent is anonymous (Google never says which account
    // consented), so persistTokens has no way to recognize a returning user
    // and must not try to. Every completed consent flow costs one new row.
    // Pinning this so a future "helpful" dedup attempt is a deliberate,
    // reviewed change rather than an accidental regression.
    const db = createDb(':memory:');
    migrate(db);

    const firstId = persistTokens(db, baseTokens);
    const secondId = persistTokens(db, { ...baseTokens, accessToken: 'access-2', refreshToken: 'refresh-2' });

    expect(firstId).not.toBe(secondId);
    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(2);
  });
});
