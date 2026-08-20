import { resolveView, formatElapsed, pollDelayMs, describeFailure, terminalState } from './app-state.js';

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

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
}

async function loadInitialState() {
  const listing = await getJson('/extractions');
  const view = resolveView({
    authorized: listing.ok,
    extractions: listing.body?.extractions ?? [],
  });

  const newest = listing.body?.extractions?.[0];
  if (newest) currentJobId = newest.jobId;

  if (view === 'running') {
    startedAt = Date.now();
    show('running');
    poll();
    return;
  }
  if (view === 'done') { await renderResults(); return; }
  if (view === 'failed') { await renderFailure(); return; }
  show(view);
}

async function start() {
  const button = document.getElementById('start');
  button.disabled = true;

  const response = await fetch('/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: '{}',
  });

  button.disabled = false;
  if (!response.ok) { show('signed-out'); return; }

  currentJobId = (await response.json()).jobId;
  startedAt = Date.now();
  show('running');
  poll();
}

async function poll() {
  const elapsed = Date.now() - startedAt;
  document.getElementById('elapsed').textContent = formatElapsed(elapsed);

  let state;
  try {
    const status = await getJson(`/extractions/${currentJobId}`);
    state = status.body?.status;
  } catch {
    // Network blip, server restart, laptop asleep. Keep polling rather than
    // stranding the page on "running" with no way back but a manual reload.
    state = undefined;
  }

  document.getElementById('running-status').textContent =
    state ? `Status: ${state}` : 'Reconnecting…';

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
      ? `<p class="note">To run again, clear the Portability grant at
         <a href="https://myaccount.google.com/permissions" target="_blank"
         rel="noopener">myaccount.google.com/permissions</a>, then
         <a href="/auth/google">reconnect</a>.</p>`
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
 * Place names, addresses and notes are user data that arrived from Google --
 * never trust them as markup.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

document.getElementById('start').addEventListener('click', start);
document.getElementById('dismiss-warnings').addEventListener('click', () => {
  document.getElementById('warnings').hidden = true;
});
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { groupBy = tab.dataset.group; renderResults(); });
}

loadInitialState();
