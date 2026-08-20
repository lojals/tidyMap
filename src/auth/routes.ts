import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import {
  buildAuthUrl, consumeAuthState, createAuthState, exchangeCode, persistTokens,
  getValidAccessToken,
} from './oauth.js';
import { resetAuthorization } from '../portability/client.js';
import { SESSION_COOKIE, identityFrom, sessionCookieOptions } from './identity.js';

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/auth/google', async (_request, reply) => {
    const state = createAuthState(ctx.db);
    return reply.redirect(buildAuthUrl(ctx.config, state), 302);
  });

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      const { code, error, state } = request.query;

      if (error) return reply.code(400).send({ error: `Consent was denied: ${error}` });

      // Fastify does not schema-validate this querystring, so a repeated
      // ?state=a&state=b parses to a string[] at runtime despite the TS type
      // above claiming `string | undefined`. Passing an array straight into
      // a Drizzle `eq()` binds it as multiple SQL parameters and throws
      // "Too many parameter values were provided" -- an unhandled 500, not a
      // validation failure. Guarding the runtime type here turns that into
      // an ordinary 400.
      //
      // Verified before anything else touches the code: without this, the
      // callback would accept any code from any source with no correlation
      // to a request this server initiated (authorization-code injection).
      if (typeof state !== 'string' || !consumeAuthState(ctx.db, state)) {
        return reply.code(400).send({ error: 'Missing or invalid state parameter.' });
      }

      if (!code) return reply.code(400).send({ error: 'Missing authorization code.' });

      const tokens = await exchangeCode(code, ctx.config);
      const userId = persistTokens(ctx.db, tokens);

      // Redirect rather than render JSON: after consent the browser lands
      // here, and the user should end up in the app. The opaque userId stays
      // in an HttpOnly cookie so it never reaches the URL or browser history.
      return reply
        .setCookie(SESSION_COOKIE, userId, sessionCookieOptions())
        .redirect('/', 302);
    },
  );

  app.post<{ Body: { userId?: string } }>('/auth/reset', async (request, reply) => {
    const userId = identityFrom(request);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });

    const accessToken = await getValidAccessToken(ctx.db, userId, ctx.config);
    await resetAuthorization(accessToken);

    return reply.send({
      reset: true,
      // The reset invalidates the tokens we just used, so consent must be repeated.
      next: 'GET /auth/google to re-authorize before the next extraction.',
    });
  });
}
