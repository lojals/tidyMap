import { randomBytes, randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { oauthStates, oauthTokens, users } from '../db/schema.js';
import { PORTABILITY_SCOPES } from '../portability/client.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Portability scopes only. Google's Data Portability API rejects a scope
 * request that mixes `dataportability.*` scopes with any other scope
 * (including `openid`/`email`) with a 400 invalid_request:
 * "Requests for data portability scopes cannot have non data portability
 * scopes." — see
 * https://developers.google.com/data-portability/user-guide/configure-oauth.
 * A consequence documented on that same page: "during the OAuth flow, your
 * app does not know which Google Account was used to give consent" — the
 * token is opaque, with no id_token and no way to recognize a returning
 * user. See persistTokens below.
 */
const SCOPES = PORTABILITY_SCOPES;

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
 *
 * `state` must be a value minted by `createAuthState` and is echoed back by
 * Google on the callback; `consumeAuthState` verifies it before the callback
 * does anything else, so the callback cannot be driven by a `code` from any
 * source other than a redirect this server itself initiated.
 */
export function buildAuthUrl(config: Config, state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Ten minutes. A consent round-trip that takes longer than this has been abandoned. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Mints a new state and, as a side effect, reaps rows old enough that they
 * could never validate (consumeAuthState rejects anything past STATE_TTL_MS
 * regardless). Without this, oauth_states grows by one row per
 * GET /auth/google forever -- a row is only ever removed when that exact
 * state reaches the callback, so an abandoned consent flow leaves its row
 * behind permanently. Piggybacking the cleanup on the next state creation
 * avoids adding a background timer for what is otherwise a handful of rows.
 */
export function createAuthState(db: Db): string {
  const state = randomBytes(32).toString('base64url');
  db.delete(oauthStates).where(lt(oauthStates.createdAt, Date.now() - STATE_TTL_MS)).run();
  db.insert(oauthStates).values({ state, createdAt: Date.now() }).run();
  return state;
}

/**
 * Single-use: the state is deleted whether or not it was valid, so a captured
 * value cannot be replayed. Returns false for unknown or expired states.
 */
export function consumeAuthState(db: Db, state: string | undefined): boolean {
  if (!state) return false;
  const rows = db.select().from(oauthStates).where(eq(oauthStates.state, state)).all();
  db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
  const row = rows[0];
  return !!row && Date.now() - row.createdAt < STATE_TTL_MS;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string;
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

  // No id_token: Portability-only consent means Google never issues one (see
  // the SCOPES comment above), so there is nothing here to decode.
  const json = (await response.json()) as {
    access_token: string; refresh_token?: string; expires_in: number; scope: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
    scopes: json.scope,
  };
}

/**
 * Google never tells this app which account gave consent (no id_token, no
 * sub, no email — see the SCOPES comment above), so there is no key to look
 * an existing user up by. Every call mints a fresh opaque id and inserts a
 * new `users` row: this function cannot recognize a returning user, and does
 * not try to. Each completed consent flow costs one new row.
 */
export function persistTokens(db: Db, tokens: TokenSet): string {
  const userId = randomUUID();

  db.insert(users).values({ id: userId, createdAt: Date.now() }).run();

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
