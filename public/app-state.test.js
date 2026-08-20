import { describe, it, expect } from 'vitest';
import {
  resolveView, formatElapsed, pollDelayMs, describeFailure, terminalState, escapeHtml, describeStage,
  shouldRepaintStage,
} from './app-state.js';

describe('resolveView', () => {
  it('is signed-out when the listing was unauthorized', () => {
    expect(resolveView({ authorized: false, extractions: [] })).toBe('signed-out');
  });

  it('is ready when signed in with no extractions', () => {
    expect(resolveView({ authorized: true, extractions: [] })).toBe('ready');
  });

  it('is running for a pending or running newest extraction', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'pending' }] })).toBe('running');
    expect(resolveView({ authorized: true, extractions: [{ status: 'running' }] })).toBe('running');
  });

  it('is done for a complete newest extraction', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'complete' }] })).toBe('done');
  });

  it('is failed for failed or timed_out', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'failed' }] })).toBe('failed');
    expect(resolveView({ authorized: true, extractions: [{ status: 'timed_out' }] })).toBe('failed');
  });

  it('reads only the newest extraction, not older ones', () => {
    // The list arrives newest-first from GET /extractions.
    expect(resolveView({
      authorized: true,
      extractions: [{ status: 'running' }, { status: 'complete' }],
    })).toBe('running');
  });

  it('is failed for an unrecognized status, so a bug does not read as a stuck run', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'bogus' }] })).toBe('failed');
  });
});

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(5000)).toBe('5s');
  });

  it('shows minutes and seconds beyond a minute', () => {
    expect(formatElapsed(83_000)).toBe('1m 23s');
  });

  it('floors rather than rounds, so it never reads ahead of reality', () => {
    expect(formatElapsed(5999)).toBe('5s');
  });
});

describe('pollDelayMs', () => {
  it('polls briskly for the first minute', () => {
    expect(pollDelayMs(0)).toBe(3000);
    expect(pollDelayMs(59_000)).toBe(3000);
  });

  it('backs off after a minute, because archives take minutes', () => {
    expect(pollDelayMs(60_000)).toBe(10_000);
    expect(pollDelayMs(600_000)).toBe(10_000);
  });
});

describe('describeFailure', () => {
  it('flags RESOURCE_EXHAUSTED as ambiguous and does not urge a reset', () => {
    const result = describeFailure('Google returned RESOURCE_EXHAUSTED. ...');
    expect(result.ambiguous).toBe(true);
    // Resetting a still-valid token is destructive and irreversible, so the
    // UI must not present it as the obvious next step here.
    expect(result.showResetHelp).toBe(false);
  });

  it('offers reset help for an ordinary failure', () => {
    const result = describeFailure('enrich: something broke');
    expect(result.ambiguous).toBe(false);
    expect(result.showResetHelp).toBe(true);
  });

  it('tolerates a null error', () => {
    expect(describeFailure(null).message.length).toBeGreaterThan(0);
  });
});

describe('terminalState', () => {
  it('is complete for a complete status', () => {
    expect(terminalState('complete')).toBe('complete');
  });

  it('is failed for an explicit failed status', () => {
    expect(terminalState('failed')).toBe('failed');
  });

  it('is failed for a timed_out status', () => {
    // Asserted separately from 'failed' -- a fix that only maps one of the
    // two terminal-failure statuses would still pass a test that checked
    // just the other.
    expect(terminalState('timed_out')).toBe('failed');
  });

  it('is pending for a running status', () => {
    expect(terminalState('running')).toBe('pending');
  });

  it('is pending for a pending status', () => {
    expect(terminalState('pending')).toBe('pending');
  });

  it('is pending for an undefined status, e.g. a poll that could not reach the server', () => {
    expect(terminalState(undefined)).toBe('pending');
  });

  it('is failed for an unrecognized status, matching resolveView on the same case', () => {
    // Deliberately not 'pending': undefined means "the fetch itself failed",
    // which is worth retrying, but an actual unfamiliar status string means
    // the server said something this client doesn't understand -- a bug, not
    // a state worth polling forever. resolveView makes the same call.
    expect(terminalState('bogus')).toBe('failed');
  });
});

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes a mix in one pass, including a naive script-tag attempt', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Bar Cañete')).toBe('Bar Cañete');
  });

  it('coerces a non-string value via String() rather than throwing', () => {
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('describeStage', () => {
  const STAGE_KEYS = ['requesting', 'preparing', 'downloading', 'reading', 'resolving', 'organizing'];

  it('pins the full six-stage sequence to its own label and index -- a mapping ' +
     'that returned one constant value for every stage would still pass a test ' +
     'that only checked truthiness or object shape, so this pins the exact arrays', () => {
    const labels = STAGE_KEYS.map((key) => describeStage(key, null).label);
    const indices = STAGE_KEYS.map((key) => describeStage(key, null).index);

    expect(labels).toEqual([
      'Asking Google for your places',
      'Google is preparing your export',
      'Downloading your export',
      'Reading your saved lists',
      'Looking up your places',
      'Putting your list together',
    ]);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('gives every stage its own exact sublabel', () => {
    const sublabels = STAGE_KEYS.map((key) => describeStage(key, null).sublabel);

    expect(sublabels).toEqual([
      'Sending the export request.',
      'This usually takes two to five minutes. Nothing to do but wait.',
      'Collecting the archive Google just built.',
      'Pulling the places out of the export.',
      'Matching each pin to a real place and giving it a category.',
      'Saving everything and noting anything that needs a look.',
    ]);
  });

  it('appends running progress to the resolving sublabel when stageDetail is present', () => {
    expect(describeStage('resolving', '12 of 20')).toEqual({
      label: 'Looking up your places',
      sublabel: 'Matching each pin to a real place and giving it a category — 12 of 20 so far.',
      index: 4,
    });
  });

  it('renders a clean resolving sublabel with no dangling dash when stageDetail is absent', () => {
    // stageDetail is set only during resolving and setStage clears it on
    // every transition, so a zero-place run reaches resolving having never
    // set it at all -- this must not render a trailing "— ".
    expect(describeStage('resolving', null).sublabel)
      .toBe('Matching each pin to a real place and giving it a category.');
    expect(describeStage('resolving', undefined).sublabel).not.toContain('—');
  });

  it('treats a missing stage as a real first-run state, not "unknown"', () => {
    expect(describeStage(null, null)).toEqual({
      label: 'Getting started',
      sublabel: 'Setting up your run.',
      index: 0,
    });
    expect(describeStage(undefined, undefined)).toEqual({
      label: 'Getting started',
      sublabel: 'Setting up your run.',
      index: 0,
    });
  });

  it('does not crash and does not print "undefined" for an unrecognized stage string', () => {
    // Server/client skew is a bug signal, not a future stage worth guessing
    // at -- index: null so the rail lights nothing and the step counter hides.
    const result = describeStage('some-future-stage', null);
    expect(result).toEqual({ label: 'Working…', sublabel: '', index: null });
    expect(result.label).not.toContain('undefined');
    expect(result.sublabel).not.toContain('undefined');
  });
});

describe('shouldRepaintStage', () => {
  it('repaints while the run is still going', () => {
    expect(shouldRepaintStage({ ok: true, body: { status: 'running' } })).toBe(true);
    expect(shouldRepaintStage({ ok: true, body: { status: 'pending' } })).toBe(true);
  });

  // The regression this function was extracted for. setStatus nulls stage on
  // every terminal status, so repainting on the poll that discovers one
  // rewinds the screen from "Putting your list together / Step 6 of 6" to
  // "Getting started / Step 1 of 6" and holds it there for the length of the
  // results fetch -- exactly when the finished list should be appearing. All
  // three terminal statuses are asserted as one array because a fix that
  // special-cased only 'complete' would leave the same rewind on both
  // failure paths.
  it('does not repaint on any terminal status, whose stage the server has nulled', () => {
    const statuses = ['complete', 'failed', 'timed_out'];
    expect(statuses.map((status) => shouldRepaintStage({ ok: true, body: { status } })))
      .toEqual([false, false, false]);
  });

  it('does not repaint when the status fetch failed, so a blip keeps the last stage', () => {
    // Both shapes poll() can produce: a thrown fetch (undefined), and a
    // non-ok response, which getJson returns as {ok:false, body:null} rather
    // than throwing. A guard written only against `undefined` would sail past
    // the second and repaint a stage read off a null body.
    expect(shouldRepaintStage(undefined)).toBe(false);
    expect(shouldRepaintStage({ ok: false, body: null })).toBe(false);
  });

  it('does not repaint for an unrecognized status, matching terminalState', () => {
    expect(shouldRepaintStage({ ok: true, body: { status: 'some-future-status' } })).toBe(false);
  });
});
