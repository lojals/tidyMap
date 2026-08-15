import { describe, it, expect, vi } from 'vitest';
import { searchText } from './places-client.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const onePlace = {
  places: [{
    id: 'ChIJabc',
    displayName: { text: "Satan's Coffee Corner" },
    formattedAddress: 'Carrer de l\'Arc, Barcelona',
    primaryType: 'cafe',
    location: { latitude: 41.3825, longitude: 2.1769 },
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
};

const noSleep = async () => {};

describe('searchText', () => {
  it('posts to places:searchText with the API key and field mask', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    await searchText({ text: 'Satans Coffee' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('KEY');
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask'])
      .toBe('places.id,places.displayName,places.formattedAddress,places.primaryType,places.types,places.location,places.addressComponents');

    const body = JSON.parse(init.body as string);
    expect(body.maxResultCount).toBe(1);
    expect(body.languageCode).toBe('en');
  });

  it('includes a 500m locationBias circle when coordinates are given', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    await searchText({ text: 'x', lat: 41.3825, lng: 2.1769 },
      { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });

    const body = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(body.locationBias.circle).toEqual({
      center: { latitude: 41.3825, longitude: 2.1769 }, radius: 500,
    });
  });

  it('omits locationBias when coordinates are absent', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    await searchText({ text: 'x' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).locationBias).toBeUndefined();
  });

  it('returns the first place', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    const result = await searchText({ text: 'x' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(result!.id).toBe('ChIJabc');
  });

  it('returns null when there are no matches', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({}));
    const result = await searchText({ text: 'x' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(result).toBeNull();
  });

  it('retries on 429 and succeeds', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(ok(onePlace));
    const result = await searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result!.id).toBe('ChIJabc');
  });

  it('returns null after exhausting retries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, maxRetries: 2, sleep: noSleep });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toBeNull();
  });

  it('backs off exponentially between retries, not at a constant delay', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const sleep = vi.fn(async () => {});
    await searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, maxRetries: 3, sleep });

    expect(sleep.mock.calls).toEqual([[250], [500], [1000]]);
  });

  it('does not retry a 403 — that is a billing or key problem', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep })).rejects.toThrow(/403/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
