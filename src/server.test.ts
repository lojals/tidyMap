import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import { buildServer } from './server.js';
import { createDb, migrate } from './db/client.js';
import { users } from './db/schema.js';
import { loadConfig } from './config.js';
import { ReauthRequiredError } from './auth/oauth.js';
import { ConsentAlreadyUsedError } from './portability/client.js';

function buildTestServer() {
  const db = createDb(':memory:');
  migrate(db);
  const config = loadConfig({
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
  });
  return { app: buildServer({ db, config }), db };
}

// buildServer's error handler maps error names to HTTP statuses. No route
// wired up today happens to let ConsentAlreadyUsedError reach it (nothing
// currently lets it escape runExtraction's try/catch), so that mapping is
// exercised with a throwing test route rather than a real call site.
// ReauthRequiredError, in contrast, IS reachable in production -- POST
// /auth/reset calls getValidAccessToken unguarded -- so it gets both: a
// synthetic-route test pinning the exact mapping/message, and a real-route
// test proving the production wiring actually reaches that mapping.
describe('buildServer error handler', () => {
  it('maps ReauthRequiredError to 401 through a real route (POST /auth/reset for a user with no stored tokens)', async () => {
    const { app, db } = buildTestServer();
    db.insert(users).values({ id: 'u1', createdAt: 0 }).run();

    // No oauthTokens row exists for u1, so getValidAccessToken throws
    // ReauthRequiredError('No tokens stored for this user.') unguarded --
    // this is the actual production call site, not a synthetic route.
    const response = await app.inject({
      method: 'POST', url: '/auth/reset', payload: { userId: 'u1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('maps ReauthRequiredError to 401', async () => {
    const { app } = buildTestServer();
    app.get('/__test/reauth', async () => {
      throw new ReauthRequiredError('re-auth needed');
    });

    const response = await app.inject({ method: 'GET', url: '/__test/reauth' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 're-auth needed Re-authorize at GET /auth/google.' });
  });

  it('maps ConsentAlreadyUsedError to 409', async () => {
    const { app } = buildTestServer();
    app.get('/__test/consent', async () => {
      throw new ConsentAlreadyUsedError();
    });

    const response = await app.inject({ method: 'GET', url: '/__test/consent' });
    expect(response.statusCode).toBe(409);
  });

  it('maps an unrecognized error to 500 with a fixed message, not the original', async () => {
    const { app } = buildTestServer();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.get('/__test/boom', async () => {
      throw new Error('boom: internal detail that must not reach the client');
    });

    const response = await app.inject({ method: 'GET', url: '/__test/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal error.' });
    expect(response.body).not.toContain('internal detail');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// @fastify/static could be dropped from buildServer entirely and every other
// test in this suite would still pass -- the 401 tests elsewhere only prove
// static isn't shadowing the API (the negative case). This is the positive
// case: something actually serves the UI from '/'.
describe('static UI', () => {
  it('serves the UI from a root resolved off the module, not the cwd', async () => {
    // The chdir is what makes this load-bearing. server.ts resolves its
    // static root from import.meta.url specifically because `npm start`
    // launches dist/server.js from an arbitrary working directory -- without
    // the chdir here, this test would still pass under a regression back to
    // join(process.cwd(), 'public'), since vitest's cwd happens to be the
    // repo root already.
    const cwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const { app } = buildTestServer();
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('id="view-signed-out"');
    } finally {
      process.chdir(cwd);
    }
  });

  it('tells a returning user how to clear a stale Google authorization', async () => {
    // This hint cannot be conditional. When Google rejects a re-consent with
    // "Incremental auth is not allowed for the requested scopes" it renders
    // its own error page and the browser never returns here, so no client
    // code of ours ever runs. The escape route has to be on the page before
    // the user clicks, or they are simply stuck.
    const { app } = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/' });

    // Scoped to the signed-out section on purpose: the permissions link also
    // appears in the done and failed views, so asserting against the whole
    // document would pass without this hint existing at all.
    const signedOut = response.body
      .split('id="view-signed-out"')[1]!
      .split('</section>')[0]!;

    expect(signedOut).toContain('myaccount.google.com/permissions');
    expect(signedOut).toContain('Incremental auth is not allowed');
  });
});
