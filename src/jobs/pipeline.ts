import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { ExportFile } from '../domain/types.js';
import { getValidAccessToken } from '../auth/oauth.js';
import { downloadArchive } from '../archive/download.js';
import { enrich } from '../enrich/index.js';
import { parseExport } from '../parse/index.js';
import { getArchiveState, initiateArchive } from '../portability/client.js';
import { extractions, places, rawArtifacts } from '../db/schema.js';
import { loadFixtureExport } from './fixture-source.js';

export interface PipelineDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutMs?: number;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_CAP_MS = 30_000;

function setStatus(ctx: AppContext, id: string, status: string, extra: Record<string, unknown> = {}) {
  ctx.db.update(extractions)
    .set({ status, updatedAt: Date.now(), ...extra })
    .where(eq(extractions.id, id))
    .run();
}

/**
 * Polls until the archive is ready. On timeout the job is marked `timed_out`
 * but the archiveJobId is kept, so polling can resume later — re-initiating
 * would burn the one-time consent for nothing.
 */
async function waitForArchive(
  accessToken: string,
  jobId: string,
  deps: PipelineDeps,
): Promise<string[] | 'timed_out'> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.pollTimeoutMs ?? POLL_TIMEOUT_MS);

  let attempt = 0;
  while (now() < deadline) {
    const state = await getArchiveState(accessToken, jobId, { ...(deps.fetch ? { fetch: deps.fetch } : {}) });

    if (state.state === 'COMPLETE') return state.urls;
    if (state.state === 'FAILED' || state.state === 'CANCELLED') {
      throw new Error(`Google reported the archive job as ${state.state}.`);
    }

    await sleep(Math.min(2 ** attempt * 2000, POLL_CAP_MS));
    attempt++;
  }

  return 'timed_out';
}

async function fetchExportFiles(
  ctx: AppContext,
  extractionId: string,
  userId: string,
  deps: PipelineDeps,
): Promise<ExportFile[] | 'timed_out'> {
  if (ctx.config.portabilitySource === 'fixture') return loadFixtureExport();

  const accessToken = await getValidAccessToken(ctx.db, userId, ctx.config, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const { archiveJobId } = await initiateArchive(accessToken, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  ctx.db.update(extractions)
    .set({ archiveJobId, updatedAt: Date.now() })
    .where(eq(extractions.id, extractionId))
    .run();

  const urls = await waitForArchive(accessToken, archiveJobId, deps);
  if (urls === 'timed_out') return 'timed_out';

  return downloadArchive(urls, { ...(deps.fetch ? { fetch: deps.fetch } : {}) });
}

/**
 * Runs the full pipeline for one extraction and records the outcome.
 *
 * Never throws — every failure path is written to the extraction row so the
 * status endpoint can report it. The 20-item cap is applied inside
 * parseExport, before enrichment, so a failure later never costs Places calls
 * for items beyond the cap.
 */
export async function runExtraction(
  extractionId: string,
  userId: string,
  ctx: AppContext,
  deps: PipelineDeps = {},
): Promise<void> {
  try {
    setStatus(ctx, extractionId, 'running');

    const files = await fetchExportFiles(ctx, extractionId, userId, deps);
    if (files === 'timed_out') {
      setStatus(ctx, extractionId, 'timed_out', {
        error: 'Archive was not ready within 15 minutes. Poll GET /extractions/:id again later.',
      });
      return;
    }

    for (const file of files) {
      ctx.db.insert(rawArtifacts).values({
        id: randomUUID(),
        extractionId,
        path: file.path,
        content: Buffer.from(file.content, 'utf8'),
      }).run();
    }

    const items = parseExport(files, ctx.config.extractionLimit);

    const resolved = await enrich(items, {
      apiKey: ctx.config.placesApiKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });

    for (const place of resolved) {
      ctx.db.insert(places).values({
        id: randomUUID(),
        extractionId,
        payload: place,
      }).run();
    }

    setStatus(ctx, extractionId, 'complete', { error: null });
  } catch (error) {
    try {
      setStatus(ctx, extractionId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (writeError) {
      // The extraction row itself could not be updated -- there is nowhere
      // left to persist the failure. runExtraction is invoked from a
      // fire-and-forget job runner with no caller positioned to catch a
      // rejection, so letting this propagate would turn a recorded failure
      // into an unhandled promise rejection instead. console.error is the
      // last resort so the failure is not silently lost.
      console.error(
        `runExtraction: failed to record failure status for extraction ${extractionId}.`,
        { originalError: error, writeError },
      );
    }
  }
}
