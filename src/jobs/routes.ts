import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { GroupBy, ResolvedPlace } from '../domain/types.js';
import { extractions, places, users } from '../db/schema.js';
import { group } from '../group/index.js';
import { runExtraction, type PipelineDeps } from './pipeline.js';

const GROUP_BY_VALUES: GroupBy[] = ['category', 'city', 'country'];

export interface JobRouteDeps extends PipelineDeps {
  /**
   * Await the pipeline before responding. Tests set this so a request/response
   * cycle is deterministic; production leaves it false so POST returns 202 at once.
   */
  awaitPipeline?: boolean;
}

export async function jobRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: JobRouteDeps = {},
): Promise<void> {
  app.post<{ Body: { userId: string } }>('/extractions', async (request, reply) => {
    const { userId } = request.body ?? {};
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });

    const user = ctx.db.select().from(users).where(eq(users.id, userId)).all();
    if (!user[0]) {
      return reply.code(400).send({ error: `Unknown userId "${userId}". Authorize at GET /auth/google.` });
    }

    const jobId = randomUUID();
    const now = Date.now();
    ctx.db.insert(extractions).values({
      id: jobId, userId, status: 'pending', createdAt: now, updatedAt: now,
    }).run();

    const run = runExtraction(jobId, userId, ctx, deps);
    if (deps.awaitPipeline) await run;
    else void run;

    return reply.code(202).send({ jobId, status: 'pending' });
  });

  app.get<{ Params: { jobId: string } }>('/extractions/:jobId', async (request, reply) => {
    const rows = ctx.db.select().from(extractions)
      .where(eq(extractions.id, request.params.jobId)).all();
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'No such extraction.' });

    return reply.send({
      jobId: row.id,
      status: row.status,
      archiveJobId: row.archiveJobId,
      error: row.error,
      warnings: row.warnings,
    });
  });

  app.get<{ Params: { jobId: string }; Querystring: { groupBy?: string } }>(
    '/extractions/:jobId/results',
    async (request, reply) => {
      const rows = ctx.db.select().from(extractions)
        .where(eq(extractions.id, request.params.jobId)).all();
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'No such extraction.' });

      if (row.status !== 'complete') {
        return reply.code(409).send({
          error: `Extraction is ${row.status}, not complete.`,
          status: row.status,
        });
      }

      const groupBy = (request.query.groupBy ?? 'category') as GroupBy;
      if (!GROUP_BY_VALUES.includes(groupBy)) {
        return reply.code(400).send({
          error: `groupBy must be one of ${GROUP_BY_VALUES.join(', ')}.`,
        });
      }

      // Phase 1 caps extractions at 20 items (config.extractionLimit), so
      // reading every places row for an extraction and grouping in JS here
      // is bounded and cheap. Revisit if that cap ever grows substantially.
      const stored = ctx.db.select().from(places)
        .where(eq(places.extractionId, row.id)).all();

      return reply.send(group(stored.map((p) => p.payload as ResolvedPlace), groupBy));
    },
  );
}
