import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';
import { createDb, migrate } from './db/client.js';
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
  return buildServer({ db, config });
}

// buildServer's error handler maps error names to HTTP statuses. No route
// wired up today happens to let ReauthRequiredError or ConsentAlreadyUsedError
// reach it (auth/reset's ReauthRequiredError is the only real path; nothing
// currently lets ConsentAlreadyUsedError escape runExtraction's try/catch), so
// this exercises the mapping directly with a throwing test route rather than
// relying on those call sites to stay wired the way they are today.
describe('buildServer error handler', () => {
  it('maps ReauthRequiredError to 401', async () => {
    const app = buildTestServer();
    app.get('/__test/reauth', async () => {
      throw new ReauthRequiredError('re-auth needed');
    });

    const response = await app.inject({ method: 'GET', url: '/__test/reauth' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 're-auth needed Re-authorize at GET /auth/google.' });
  });

  it('maps ConsentAlreadyUsedError to 409', async () => {
    const app = buildTestServer();
    app.get('/__test/consent', async () => {
      throw new ConsentAlreadyUsedError();
    });

    const response = await app.inject({ method: 'GET', url: '/__test/consent' });
    expect(response.statusCode).toBe(409);
  });

  it('maps an unrecognized error to 500', async () => {
    const app = buildTestServer();
    app.get('/__test/boom', async () => {
      throw new Error('boom');
    });

    const response = await app.inject({ method: 'GET', url: '/__test/boom' });
    expect(response.statusCode).toBe(500);
  });
});
