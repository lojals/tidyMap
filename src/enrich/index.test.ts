import { describe, it, expect, vi } from 'vitest';
import { enrich } from './index.js';
import type { SavedItem } from '../domain/types.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const cafe = (id: string) => ({
  places: [{
    id,
    displayName: { text: 'Resolved Name' },
    formattedAddress: 'Some Street, Barcelona',
    primaryType: 'cafe',
    location: { latitude: 41.38, longitude: 2.17 },
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
});

const item = (over: Partial<SavedItem>): SavedItem =>
  ({ sourceId: 's1', title: 'Cafe', sourceList: 'Want to go', ...over });

const noSleep = async () => {};

describe('enrich', () => {
  it('resolves placeId, city, country, and category', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJ1')));
    const [place] = await enrich([item({})], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(place).toMatchObject({
      placeId: 'ChIJ1', city: 'Barcelona', country: 'Spain',
      countryCode: 'ES', category: 'Food & Drink', primaryType: 'cafe', resolved: true,
    });
  });

  it('combines title and address into the search text', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJ1')));
    await enrich([item({ title: 'Cafe', address: 'Main St' })],
      { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).textQuery).toBe('Cafe Main St');
  });

  it('keeps unresolved items with category Unknown', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({}));
    const [place] = await enrich([item({
      title: 'Ghost Bar', note: 'keep me',
      mapsUrl: 'https://maps.google.com/?cid=123', lat: 41.1, lng: 2.2,
    })], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(place).toMatchObject({
      placeId: null, name: 'Ghost Bar', category: 'Unknown',
      city: null, resolved: false, note: 'keep me',
      mapsUrl: 'https://maps.google.com/?cid=123', lat: 41.1, lng: 2.2,
    });
  });

  it('deduplicates by placeId and merges sourceLists', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJsame')));
    const places = await enrich([
      item({ sourceId: 'a', sourceList: 'Starred places' }),
      item({ sourceId: 'b', sourceList: 'Want to go' }),
    ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(places).toHaveLength(1);
    expect(places[0]!.sourceLists).toEqual(['Starred places', 'Want to go']);
  });

  it('never deduplicates unresolved items together', async () => {
    // Two distinct titles mean two distinct cache keys, so fetch is really
    // called twice — mockImplementation gives each call its own Response,
    // since a Response body can only be read once.
    const fetch = vi.fn().mockImplementation(async () => ok({}));
    const places = await enrich([
      item({ sourceId: 'a', title: 'One' }), item({ sourceId: 'b', title: 'Two' }),
    ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
    expect(places).toHaveLength(2);
  });

  it('names the offending item\'s title when a Places lookup fails mid-run', async () => {
    // Distinct titles so each gets its own cache entry and its own fetch
    // call: the first resolves fine, the second hits a fatal (401/403/400)
    // response that searchText throws on. The item that actually failed
    // must be identifiable from the error alone, without an API key or
    // token appearing in it.
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(cafe('ChIJ1')))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }));

    await expect(enrich([
      item({ sourceId: 'a', title: 'Good Place' }),
      item({ sourceId: 'b', title: 'Bad Place' }),
    ], { apiKey: 'super-secret-key', fetch: fetch as never, sleep: noSleep }))
      .rejects.toThrow('place lookup failed for "Bad Place"');
  });

  it('does not leak the API key into an enrichment failure message', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    let caught: unknown;
    try {
      await enrich([item({ title: 'Ghost Bar' })], {
        apiKey: 'super-secret-key', fetch: fetch as never, sleep: noSleep,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('super-secret-key');
  });

  it('caches by query so a repeated search is fetched once', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJ1')));
    await enrich([
      item({ sourceId: 'a', title: 'Same Place' }),
      item({ sourceId: 'b', title: 'Same Place' }),
    ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  describe('note merging on dedupe', () => {
    const mergedNote = async (note1: string | undefined, note2: string | undefined) => {
      const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJnote')));
      const places = await enrich([
        item({ sourceId: 'a', note: note1 }),
        item({ sourceId: 'b', note: note2 }),
      ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
      return places[0]!.note;
    };

    it('keeps the first note when the second has none', async () => {
      expect(await mergedNote('first note', undefined)).toBe('first note');
    });

    it('keeps the second note when the first has none', async () => {
      expect(await mergedNote(undefined, 'second note')).toBe('second note');
    });

    it('joins two different notes with an em dash', async () => {
      expect(await mergedNote('first note', 'second note')).toBe('first note — second note');
    });

    it('does not duplicate an identical note', async () => {
      expect(await mergedNote('same note', 'same note')).toBe('same note');
    });
  });
});
