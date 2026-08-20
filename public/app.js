import {
  resolveView, formatElapsed, pollDelayMs, describeFailure, terminalState, escapeHtml, describeStage,
  shouldRepaintStage,
} from './app-state.js';

const VIEWS = ['signed-out', 'ready', 'running', 'done', 'failed'];

let currentJobId = null;
let startedAt = 0;
let groupBy = 'category';
let pollTimer = null;

function show(view) {
  for (const name of VIEWS) {
    document.getElementById(`view-${name}`).hidden = name !== view;
  }
}

/**
 * Renders the full-screen single-focus stage: label, sublabel, "STEP n OF 6"
 * (hidden when index is null -- an unrecognized stage, a bug signal, not a
 * position in the sequence), and the six-segment rail. The rail fills every
 * segment up to and including the current index in one paint, including on
 * a fixture-mode run that jumps straight to `reading` -- a rail with holes
 * would read as broken, and there is no sub-progress to animate through.
 */
function renderStage(stage, stageDetail) {
  const { label, sublabel, index } = describeStage(stage, stageDetail);

  document.getElementById('running-label').textContent = label;
  document.getElementById('running-status').textContent = sublabel;

  const step = document.getElementById('running-step');
  step.hidden = index === null;
  step.textContent = index === null ? '' : `Step ${index + 1} of 6`;

  const segments = document.querySelectorAll('#running-rail .rail-segment');
  segments.forEach((segment, i) => {
    const filled = index !== null && i <= index;
    segment.classList.toggle('filled', filled);
    segment.classList.toggle('current', filled && i === index);
  });
}

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
}

async function loadInitialState() {
  try {
    const listing = await getJson('/extractions');
    const view = resolveView({
      authorized: listing.ok,
      extractions: listing.body?.extractions ?? [],
    });

    const newest = listing.body?.extractions?.[0];
    if (newest) currentJobId = newest.jobId;

    if (view === 'running') {
      // Resume the actual elapsed time, not a fresh clock. GET /extractions
      // already returned createdAt for this job -- restarting from Date.now()
      // would report 0s on reload and restart the fast-poll window, inviting
      // the user to wait out a second full timeout on a job already minutes in.
      startedAt = newest.createdAt;
      show('running');
      // Paint a real first-run state immediately rather than leaving the
      // labels blank until the first poll response lands -- poll() below
      // corrects this to the job's actual stage within one round trip.
      renderStage(undefined, undefined);
      poll();
      return;
    }
    if (view === 'done') { await renderResults(); return; }
    if (view === 'failed') { await renderFailure(); return; }
    show(view);
  } catch {
    // Every <section> ships `hidden`, so a rejected fetch here (server not
    // up yet, network blip) with nothing else calling show() would leave a
    // bare header over an empty page -- no error, no retry. Fall through to
    // a usable, reloadable state instead of leaving the page blank.
    document.getElementById('connection-note').hidden = false;
    show('signed-out');
  }
}

async function start() {
  const button = document.getElementById('start');
  button.disabled = true;

  try {
    const response = await fetch('/extractions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });

    if (!response.ok) { show('signed-out'); return; }

    currentJobId = (await response.json()).jobId;
    startedAt = Date.now();
    show('running');
    renderStage(undefined, undefined);
    poll();
  } finally {
    // Otherwise a rejected fetch (network blip) leaves the button disabled
    // forever with no way to retry short of a full reload.
    button.disabled = false;
  }
}

async function poll() {
  const elapsed = Date.now() - startedAt;
  document.getElementById('elapsed').textContent = formatElapsed(elapsed);

  let status;
  try {
    status = await getJson(`/extractions/${currentJobId}`);
  } catch {
    // Network blip, server restart, laptop asleep. Keep polling rather than
    // stranding the page on "running" with no way back but a manual reload.
    status = undefined;
  }

  // Only repaint the stage when the fetch actually succeeded (2xx with a
  // body). A transient failure -- network blip or a non-ok response, body
  // null either way -- must leave the last-rendered stage on screen: calling
  // describeStage(undefined) here would flip a correct "Google is preparing
  // your export" back to "Getting started" on every hiccup. Surface the
  // reconnecting note instead, without touching the stage labels.
  const reconnecting = !status?.ok;
  document.getElementById('reconnecting-note').hidden = !reconnecting;

  const state = status?.ok ? status.body.status : undefined;

  // Both reasons a repaint would be wrong here -- a failed fetch, and a
  // terminal status whose stage the server has already nulled -- live in
  // shouldRepaintStage, where they are tested.
  if (shouldRepaintStage(status)) {
    renderStage(status.body.stage, status.body.stageDetail);
  }

  if (terminalState(state) === 'complete') { await renderResults(); return; }
  if (terminalState(state) === 'failed') { await renderFailure(); return; }

  pollTimer = setTimeout(poll, pollDelayMs(elapsed));
}

async function renderFailure() {
  clearTimeout(pollTimer);
  const status = await getJson(`/extractions/${currentJobId}`);
  const { message, ambiguous, showResetHelp } = describeFailure(status.body?.error ?? null);

  document.getElementById('failure').textContent = message;
  document.getElementById('failure-help').innerHTML = ambiguous
    ? `<p class="note">Google returns this for both a spent authorization and ordinary
       rate limiting, and they are indistinguishable from the response. Resetting
       destroys a token that may still be valid &mdash; if you have not just run an
       extraction, wait and retry before resetting.</p>`
    : showResetHelp
      ? `<div class="rerun">
           <p class="note">To run again, clear the Portability grant at
           <a href="https://myaccount.google.com/permissions" target="_blank"
           rel="noopener">myaccount.google.com/permissions</a>, or use the
           button below, then <a href="/auth/google">reconnect</a>.</p>
           <button class="button" id="reset-failed">Reset authorization</button>
         </div>`
      : '';

  show('failed');
}

async function renderResults() {
  clearTimeout(pollTimer);

  const status = await getJson(`/extractions/${currentJobId}`);
  const results = await getJson(`/extractions/${currentJobId}/results?groupBy=${groupBy}`);
  if (!results.ok) {
    // The job itself did not fail -- the results fetch did. Report that
    // distinctly rather than falling through to renderFailure(), which
    // would report the job's (empty) error and leave the view blank.
    document.getElementById('failure').textContent =
      `The extraction finished, but its results could not be loaded (HTTP ${results.status}).`;
    document.getElementById('failure-help').innerHTML =
      '<p class="note">The places are still stored. Reloading the page will retry.</p>';
    show('failed');
    return;
  }

  const { totalPlaces, unresolvedCount, results: groups } = results.body;
  document.getElementById('summary').textContent =
    `${totalPlaces} places, ${groups.length} groups, ${unresolvedCount} unresolved`;

  document.getElementById('warnings-text').textContent = status.body?.warnings ?? '';
  document.getElementById('warnings').hidden = !status.body?.warnings;

  document.getElementById('groups').innerHTML = groups.map((groupItem) => {
    const key = groupItem[groupBy];
    const places = groupItem.places.map((place) => `
      <div class="place">
        <div>${escapeHtml(place.name)}</div>
        ${place.address ? `<div class="addr">${escapeHtml(place.address)}</div>` : ''}
        ${place.note ? `<div class="note-text">${escapeHtml(place.note)}</div>` : ''}
      </div>`).join('');

    return `<section class="group">
      <h3>${groupItem.emoji} ${escapeHtml(key)} <span class="count">${groupItem.places.length}</span></h3>
      ${places}
    </section>`;
  }).join('');

  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.group === groupBy));
  }

  show('done');
}

/**
 * POST /auth/reset, gated on an explicit confirmation: it revokes the
 * Portability grant even if it is still valid, and that cannot be undone
 * from here -- only a fresh consent round-trip at /auth/google recovers.
 */
async function resetAuthorization() {
  const confirmed = window.confirm(
    'This permanently revokes the current Google authorization, even if it ' +
    'is still valid. You will need to reconnect before running another ' +
    'extraction. This cannot be undone. Continue?',
  );
  if (!confirmed) return;

  try {
    const response = await fetch('/auth/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      window.alert(`Reset failed: ${body?.error ?? `HTTP ${response.status}`}`);
      return;
    }

    // Reload rather than manipulating view state by hand: the extraction
    // list for this userId is unchanged by a reset (only the tokens are
    // invalidated), so the simplest correct thing is to let loadInitialState
    // re-derive the view from a fresh GET /extractions.
    window.location.reload();
  } catch (error) {
    // A rejected fetch (network blip) must not fail silently -- the user
    // just confirmed a destructive, irreversible action and needs to know
    // whether it actually happened.
    window.alert(`Reset failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

document.getElementById('start').addEventListener('click', start);
document.getElementById('dismiss-warnings').addEventListener('click', () => {
  document.getElementById('warnings').hidden = true;
});
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { groupBy = tab.dataset.group; renderResults(); });
}
// Delegated: #reset-failed is injected via innerHTML in renderFailure(),
// which replaces the element (and any directly bound listener) on every
// call, so only a listener on a stable ancestor survives that.
document.addEventListener('click', (event) => {
  if (event.target instanceof HTMLElement && event.target.matches('#reset-done, #reset-failed')) {
    resetAuthorization();
  }
});

loadInitialState();
