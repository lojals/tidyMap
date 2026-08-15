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
    await expect(initiateArchive('tok', { fetch: fetch as never })).rejects.toThrow(/500/);
  });
});

describe('getArchiveState', () => {
  it('polls the job state endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ state: 'IN_PROGRESS' }));
    const result = await getArchiveState('tok', 'job-1', { fetch: fetch as never });

    expect(fetch.mock.calls[0]![0])
      .toBe('https://dataportability.googleapis.com/v1/archiveJobs/job-1/portabilityArchiveState');
    expect(result).toEqual({ state: 'IN_PROGRESS', urls: [] });
  });

  it('returns signed URLs when complete', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ state: 'COMPLETE', urls: ['https://a', 'https://b'] }));
    const result = await getArchiveState('tok', 'job-1', { fetch: fetch as never });
    expect(result).toEqual({ state: 'COMPLETE', urls: ['https://a', 'https://b'] });
  });
});

describe('resetAuthorization', () => {
  it('posts to authorization:reset', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    await resetAuthorization('tok', { fetch: fetch as never });
    expect(fetch.mock.calls[0]![0])
      .toBe('https://dataportability.googleapis.com/v1/authorization:reset');
  });
});
