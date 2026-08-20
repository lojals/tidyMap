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
  // Falls through to 'failed' for anything else, including a status string
  // this client doesn't recognize -- see the comment on terminalState below,
  // which makes the same call for the same reason.
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
 * Whether a job status means the pipeline has stopped, and how it ended.
 * Lives here rather than in app.js because which statuses are terminal is a
 * business decision, and app.js has no tests by design.
 *
 * `undefined` is its own case, not "unrecognized" -- poll() in app.js passes
 * it specifically when a status *fetch* failed (network blip, server
 * restart), and the deliberate call there is to keep polling rather than
 * strand the page. An actual status *string* the client doesn't recognize is
 * different: server and client ship together in this app, so an unfamiliar
 * value is a bug signal, not a future state worth waiting out. That case
 * resolves to 'failed', matching resolveView's fallthrough above, so the
 * user gets the reset escape hatch instead of polling a status that will
 * never resolve.
 * @param {string|undefined} status
 * @returns {'complete'|'failed'|'pending'}
 */
export function terminalState(status) {
  if (status === 'complete') return 'complete';
  if (status === 'failed' || status === 'timed_out') return 'failed';
  if (status === 'pending' || status === 'running' || status === undefined) return 'pending';
  return 'failed';
}

/**
 * Place names, addresses and notes are user data that arrived from Google --
 * never trust them as markup. Lives here, not app.js, because app.js has no
 * tests by design and this is the highest-consequence logic in the client.
 * @param {unknown} value
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

const STAGES = [
  { key: 'requesting', label: 'Asking Google for your places', sublabel: 'Sending the export request.' },
  { key: 'preparing', label: 'Google is preparing your export', sublabel: 'This usually takes two to five minutes. Nothing to do but wait.' },
  { key: 'downloading', label: 'Downloading your export', sublabel: 'Collecting the archive Google just built.' },
  { key: 'reading', label: 'Reading your saved lists', sublabel: 'Pulling the places out of the export.' },
  { key: 'resolving', label: 'Looking up your places', sublabel: 'Matching each pin to a real place and giving it a category.' },
  { key: 'organizing', label: 'Putting your list together', sublabel: 'Saving everything and noting anything that needs a look.' },
];

/**
 * Maps a pipeline `stage` (and, for `resolving`, its `stageDetail`) to what
 * the full-screen running view renders. Pure and exhaustively tested
 * because app.js has no tests by design -- see its header comment.
 *
 * `stage` is `null`/`undefined` for a run that has started but not yet
 * recorded its first stage -- a real state, not "unknown". An unrecognized
 * stage string is server/client skew -- a bug signal, not a future stage
 * worth guessing at. Neither case may crash or print "undefined" on screen.
 * @param {string|null|undefined} stage
 * @param {string|null|undefined} stageDetail
 * @returns {{ label: string, sublabel: string, index: number|null }}
 */
export function describeStage(stage, stageDetail) {
  if (stage === null || stage === undefined) {
    return { label: 'Getting started', sublabel: 'Setting up your run.', index: 0 };
  }

  const index = STAGES.findIndex((entry) => entry.key === stage);
  if (index === -1) {
    return { label: 'Working…', sublabel: '', index: null };
  }

  const { label, sublabel } = STAGES[index];
  // Only `resolving` ever carries a stageDetail (see setResolvingProgress in
  // src/jobs/pipeline.ts); every other stage, and resolving before its first
  // progress tick, must render the plain sublabel with no dangling dash.
  const rendered = stage === 'resolving' && stageDetail
    ? `${sublabel.replace(/\.$/, '')} — ${stageDetail} so far.`
    : sublabel;

  return { label, sublabel: rendered, index };
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
