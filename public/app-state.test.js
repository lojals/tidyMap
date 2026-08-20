import { describe, it, expect } from 'vitest';
import { resolveView, formatElapsed, pollDelayMs, describeFailure } from './app-state.js';

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
