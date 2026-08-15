import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { oauthTokens, users } from '../db/schema.js';
import { PORTABILITY_SCOPES } from '../portability/client.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SCOPES = ['openid', 'email', ...PORTABILITY_SCOPES];

export interface OAuthDeps {
  fetch?: typeof globalThis.fetch;
}

export class ReauthRequiredError extends Error {
  constructor(reason: string) {
    super(`${reason} Re-authorize at GET /auth/google.`);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * Builds the consent URL. `access_type=offline` with `prompt=consent` is
 * required rather than optional here: Google only returns a refresh token on
 * a fresh consent, and Portability's one-time authorization means we come
 * back through consent regularly.
 */
export function buildAuthUrl(config: Config): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string;
  googleSub: string;
  email: string;
}

function decodeIdToken(idToken: string): { sub: string; email: string } {
  const payload = idToken.split('.')[1] ?? '';
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json) as { sub: string; email: string };
}

export async function exchangeCode(
  code: string,
  config: Config,
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const response = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    // Do not interpolate response.text() here: this error is uncaught at its
    // only call site (the /auth/google/callback route), so its message
    // reaches an unauthenticated caller's HTTP response verbatim. Google's
    // raw upstream body carries no credentials, but echoing unfiltered
    // upstream output back to the client isn't something to ship.
    throw new Error(`Token exchange failed with status ${response.status}.`);
  }

  const json = (await response.json()) as {
    access_token: string; refresh_token?: string; expires_in: number;
    scope: string; id_token: string;
  };

  const identity = decodeIdToken(json.id_token);

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
    scopes: json.scope,
    googleSub: identity.sub,
    email: identity.email,
  };
}

export function persistTokens(db: Db, tokens: TokenSet): string {
  const existing = db.select().from(users).where(eq(users.googleSub, tokens.googleSub)).all();
  const userId = existing[0]?.id ?? `user_${tokens.googleSub}`;

  if (!existing[0]) {
    db.insert(users).values({
      id: userId, googleSub: tokens.googleSub, email: tokens.email, createdAt: Date.now(),
    }).run();
  }

  db.insert(oauthTokens).values({
    userId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
  }).onConflictDoUpdate({
    target: oauthTokens.userId,
    set: {
      accessToken: tokens.accessToken,
      // Only overwrite the refresh token when Google actually sent one.
      // Google omits refresh_token on most responses, and clobbering a good
      // stored value with null would force a fresh consent on every later
      // extraction — the precise cost the one-time authorization makes expensive.
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    },
  }).run();

  return userId;
}

/** 60s of slack so a token does not expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export async function getValidAccessToken(
  db: Db,
  userId: string,
  config: Config,
  deps: OAuthDeps = {},
): Promise<string> {
  const rows = db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)).all();
  const row = rows[0];
  if (!row) throw new ReauthRequiredError('No tokens stored for this user.');

  if (row.expiresAt - EXPIRY_SKEW_MS > Date.now()) return row.accessToken;
  if (!row.refreshToken) throw new ReauthRequiredError('Access token expired and no refresh token is stored.');

  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new ReauthRequiredError('Refresh token was rejected by Google.');
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  const expiresAt = Date.now() + json.expires_in * 1000;

  db.update(oauthTokens)
    .set({ accessToken: json.access_token, expiresAt })
    .where(eq(oauthTokens.userId, userId))
    .run();

  return json.access_token;
}
