import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { AppContext } from './context.js';
import { authRoutes } from './auth/routes.js';
import { jobRoutes, type JobRouteDeps } from './jobs/routes.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db/client.js';

export function buildServer(ctx: AppContext, deps: JobRouteDeps = {}): FastifyInstance {
  // logger: false is security-relevant, not a preference. The OAuth
  // authorization code arrives as a query parameter, so Fastify's default
  // request logging would write req.url — including ?code=4/0A... — to
  // stdout. Enabling logging later requires redacting that first.
  const app = Fastify({ logger: false });

  app.register(cookie);
  app.register(async (instance) => authRoutes(instance, ctx));
  app.register(async (instance) => jobRoutes(instance, ctx, deps));

  app.setErrorHandler((error: Error, _request, reply) => {
    // 401/409 are deliberate user-facing guidance (re-auth instructions, the
    // spent-consent explanation) and are safe to echo verbatim. Anything
    // unmapped falls to 500, where the real error is logged server-side but
    // never sent to the client -- an unrecognized error could be anything,
    // including a message that leaks internal state (a stack-trace-adjacent
    // string, a raw upstream body, a file path), so the response body must
    // stay a fixed, generic string.
    if (error.name === 'ReauthRequiredError') {
      return reply.code(401).send({ error: error.message });
    }
    if (error.name === 'ConsentAlreadyUsedError') {
      return reply.code(409).send({ error: error.message });
    }

    console.error(error);
    return reply.code(500).send({ error: 'Internal error.' });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  migrate(db);

  // awaitPipeline defaults to false, so POST /extractions returns 202 at once.
  const app = buildServer({ db, config });

  // Loopback only. /auth/reset is unauthenticated and destructive (it revokes
  // the Portability grant), so the listening socket is the primary access
  // control Phase 1 has. userId is an opaque randomUUID() minted server-side
  // (persistTokens in src/auth/oauth.ts) -- not derived from the Google sub,
  // which the Portability-only OAuth flow never receives -- and that opaque
  // id makes the unauthenticated /auth/reset considerably harder to target
  // than a predictable scheme would be, but it is not a substitute for the
  // loopback binding.
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`TidyMap listening on http://localhost:${config.port}`);
  console.log(`Portability source: ${config.portabilitySource}`);
  console.log(`Start here: http://localhost:${config.port}/auth/google`);
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
