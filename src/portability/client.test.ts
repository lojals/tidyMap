import { describe, it, expect, vi } from 'vitest';
import {
  initiateArchive, getArchiveState, resetAuthorization,
  PORTABILITY_RESOURCES, PORTABILITY_SCOPES, ConsentAlreadyUsedError,
} from './client.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('constants', () => {
  it('requests both saved collections and starred places', () => {
    expect(PORTABILITY_RESOURCES).toEqual(['saved.collections', 'maps.starred_places']);
  });

  it('derives full scope URLs from the resource names', () => {
    expect(PORTABILITY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/dataportability.saved.collections',
      'https://www.googleapis.com/auth/dataportability.maps.starred_places',
    ]);
  });
});

describe('initiateArchive', () => {
  it('posts the resource list with a bearer token', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ archiveJobId: 'job-1', accessType: 'ACCESS_TYPE_ONE_TIME' }));
    const result = await initiateArchive('tok', { fetch: fetch as never });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://dataportability.googleapis.com/v1/portabilityArchive:initiate');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ resources: PORTABILITY_RESOURCES });
    expect(result.archiveJobId).toBe('job-1');
  });

  it('throws ConsentAlreadyUsedError on 403 RESOURCE_EXHAUSTED', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 403 }),
    );
    await expect(initiateArchive('tok', { fetch: fetch as never }))
      .rejects.toBeInstanceOf(ConsentAlreadyUsedError);
  });

  it('throws a plain error on other failures', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(initiateArchive('tok', { fetch: fetch as never }))
      .rejects.toThrow('Portability initiate failed with 500: nope');
  });

  it('throws a plain error, not ConsentAlreadyUsedError, on a 403 without RESOURCE_EXHAUSTED', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 }),
    );
    // Capture the rejection once via try/catch rather than two separate
    // `rejects.toThrow()` calls: each call to initiateArchive invokes fetch
    // again, and mockResolvedValue returns the same Response instance every
    // time, so a second call would hit "Body is unusable: Body has already
    // been read" instead of exercising the assertion.
    let caught: unknown;
    try {
      await initiateArchive('tok', { fetch: fetch as never });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ConsentAlreadyUsedError);
    expect((caught as Error).message)
      .toBe('Portability initiate failed with 403: {"error":{"status":"PERMISSION_DENIED"}}');
  });

  it('does not assert a spent consent it cannot distinguish from rate limiting', async () => {
    // A fresh Response per call: initiateArchive's 403 branch consumes the
    // body via .text(), and a Response body can only be read once. Reusing
    // one Response instance across both calls below (e.g. via
    // mockResolvedValue) throws "Body is unusable: Body has already been
    // read" on the second call instead of exercising the code under test.
    const fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 403 }),
    );
    await expect(initiateArchive('tok', { fetch: fetch as never }))
      .rejects.toThrow(/rate limiting/i);
    // The destructive-action warning is the part that protects a valid token.
    await expect(initiateArchive('tok', { fetch: fetch as never }))
      .rejects.toThrow(/invalidates the current token/i);
  });
});

describe('getArchiveState', () => {
  it('polls the job state endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ state: 'IN_PROGRESS' }));
    const result = await getArchiveState('tok', 'job-1', { fetch: fetch as never });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://dataportability.googleapis.com/v1/archiveJobs/job-1/portabilityArchiveState');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    // No method means GET. This must NOT be folded into the POST-only call()
    // helper -- doing so would silently turn polling into a POST.
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(result).toEqual({ state: 'IN_PROGRESS', urls: [] });
  });

  it('returns signed URLs when complete', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ state: 'COMPLETE', urls: ['https://a', 'https://b'] }));
    const result = await getArchiveState('tok', 'job-1', { fetch: fetch as never });
    expect(result).toEqual({ state: 'COMPLETE', urls: ['https://a', 'https://b'] });
  });

  it('throws with the status and Google\'s message on a non-ok response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('job not found', { status: 404 }));
    await expect(getArchiveState('tok', 'job-1', { fetch: fetch as never }))
      .rejects.toThrow('Portability state check failed with 404: job not found');
  });
});

describe('resetAuthorization', () => {
  it('posts to authorization:reset', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    await resetAuthorization('tok', { fetch: fetch as never });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://dataportability.googleapis.com/v1/authorization:reset');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('throws with the status and Google\'s message on a non-ok response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('reset denied for account', { status: 400 }));
    await expect(resetAuthorization('tok', { fetch: fetch as never }))
      .rejects.toThrow('Authorization reset failed with 400: reset denied for account');
  });
});
