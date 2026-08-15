import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
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

  app.register(async (instance) => authRoutes(instance, ctx));
  app.register(async (instance) => jobRoutes(instance, ctx, deps));

  app.setErrorHandler((error: Error, _request, reply) => {
    const status = error.name === 'ReauthRequiredError' ? 401
      : error.name === 'ConsentAlreadyUsedError' ? 409
      : 500;
    return reply.code(status).send({ error: error.message });
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
  // the Portability grant), and userId is derived from the Google sub, so the
  // listening socket is the only access control Phase 1 has.
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
