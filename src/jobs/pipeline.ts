import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { ExportFile } from '../domain/types.js';
import { getValidAccessToken } from '../auth/oauth.js';
import { downloadArchive } from '../archive/download.js';
import { enrich } from '../enrich/index.js';
import { parseExport, skippedFiles, resetSkippedFiles } from '../parse/index.js';
import { unmappedTypeCounts, resetUnmappedCounts } from '../categorize/taxonomy.js';
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
 * Runs one pipeline stage and, on failure, re-throws with the stage name
 * prefixed onto the original message (e.g. `enrich: Cannot read properties
 * of undefined...`). The stored `error` column is served verbatim over HTTP,
 * so this stays a plain string prefix -- no stack trace, no wrapped Error
 * object -- just enough to say *where* in the pipeline a live failure
 * happened without grepping for the underlying message across every stage.
 */
async function withStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}: ${message}`);
  }
}

/**
 * Logs and summarizes the non-fatal diagnostics recorded by the parse and
 * enrich stages: files that could not be parsed (skippedFiles, a per-file
 * failure that must not abort the whole extraction -- "never drop a place")
 * and Places primaryType values with no taxonomy mapping (unmappedTypeCounts).
 * Neither registry is read anywhere else in the running server, so without
 * this call both are recorded into a module-global Map and then never seen
 * by anyone -- the corrupt file or gap in the taxonomy table produces no
 * signal at all even though the job reports `complete`.
 *
 * Returns null when there is nothing to report, so extractions.warnings
 * stays null on the common case rather than an empty string.
 */
function summarizeWarnings(extractionId: string): string | null {
  const skipped = skippedFiles();
  for (const [path, message] of skipped) {
    console.warn(`extraction ${extractionId}: skipped unparseable file "${path}": ${message}`);
  }

  const unmapped = unmappedTypeCounts();
  for (const [primaryType, count] of unmapped) {
    console.warn(
      `extraction ${extractionId}: unmapped primaryType "${primaryType}" (${count}x), categorized as Unknown`,
    );
  }

  const parts: string[] = [];
  if (skipped.size > 0) {
    const detail = [...skipped.entries()].map(([path, message]) => `${path} (${message})`).join('; ');
    parts.push(`Skipped ${skipped.size} unparseable file(s): ${detail}`);
  }
  if (unmapped.size > 0) {
    const detail = [...unmapped.entries()].map(([type, count]) => `${type} (${count}x)`).join(', ');
    parts.push(`${unmapped.size} unmapped primaryType value(s) categorized as Unknown: ${detail}`);
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * summarizeWarnings, guarded against throwing. Used on the failure paths
 * (timeout, catch block) where the only alternative to a warnings summary is
 * losing the extraction's recorded status entirely -- runExtraction is
 * documented never to throw, so a bug in the summary itself must not be
 * allowed to turn a recorded failure into an unhandled rejection.
 */
function safeSummarizeWarnings(extractionId: string): string | null {
  try {
    return summarizeWarnings(extractionId);
  } catch (summaryError) {
    console.error(
      `runExtraction: failed to summarize warnings for extraction ${extractionId}.`,
      summaryError,
    );
    return null;
  }
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

    // Process-global registries in a long-running server: reset before every
    // run -- before fetchExportFiles, not just before parseExport -- so that
    // even a timeout or an early failure reads only this extraction's own
    // diagnostics and never a previous run's leftovers.
    resetSkippedFiles();
    resetUnmappedCounts();

    const files = await withStage('archive', () => fetchExportFiles(ctx, extractionId, userId, deps));
    if (files === 'timed_out') {
      setStatus(ctx, extractionId, 'timed_out', {
        error: 'Archive was not ready within 15 minutes. Poll GET /extractions/:id again later.',
        warnings: safeSummarizeWarnings(extractionId),
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

    const items = await withStage('parse', async () => parseExport(files, ctx.config.extractionLimit));

    const resolved = await withStage('enrich', () => enrich(items, {
      apiKey: ctx.config.placesApiKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    }));

    const warnings = summarizeWarnings(extractionId);

    for (const place of resolved) {
      ctx.db.insert(places).values({
        id: randomUUID(),
        extractionId,
        payload: place,
      }).run();
    }

    setStatus(ctx, extractionId, 'complete', { error: null, warnings });
  } catch (error) {
    try {
      // Additive, not a replacement: whatever parse/enrich recorded before
      // the failure (e.g. a skipped corrupt export file) is exactly the
      // context worth having on a failed row, and safeSummarizeWarnings
      // cannot itself throw and take this write down with it.
      setStatus(ctx, extractionId, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        warnings: safeSummarizeWarnings(extractionId),
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
