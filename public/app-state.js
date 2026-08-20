/**
 * Pure UI decision logic. No DOM, no fetch, no globals -- everything here is
 * a function of its arguments so it can be tested directly.
 */

/**
 * Which view the page should show.
 * @param {{ authorized: boolean, extractions: { status: string }[] }} input
 * @returns {'signed-out'|'ready'|'running'|'done'|'failed'}
 */
export function resolveView(input) {
  if (!input.authorized) return 'signed-out';

  const newest = input.extractions[0];
  if (!newest) return 'ready';

  if (newest.status === 'pending' || newest.status === 'running') return 'running';
  if (newest.status === 'complete') return 'done';
  return 'failed';
}

/**
 * Elapsed time, floored so it never claims more time has passed than has.
 * @param {number} ms
 */
export function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Poll briskly at first, then back off. Archive jobs take minutes, so a fixed
 * fast poll is wasted requests and a fixed slow one feels dead.
 * @param {number} elapsedMs
 */
export function pollDelayMs(elapsedMs) {
  return elapsedMs < 60_000 ? 3000 : 10_000;
}

/**
 * How to present a failed extraction.
 *
 * RESOURCE_EXHAUSTED is deliberately NOT treated as "go reset". Google returns
 * it for both a spent one-time authorization and ordinary rate limiting, and
 * `/auth/reset` destroys a token that may still be perfectly good.
 * @param {string|null} error
 */
export function describeFailure(error) {
  const message = error ?? 'The extraction failed without reporting a reason.';
  const ambiguous = message.includes('RESOURCE_EXHAUSTED');
  return { message, ambiguous, showResetHelp: !ambiguous };
}
