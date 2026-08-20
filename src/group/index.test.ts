import { describe, it, expect } from 'vitest';
import { group } from './index.js';
import type { ResolvedPlace } from '../domain/types.js';

function place(over: Partial<ResolvedPlace>): ResolvedPlace {
  return {
    placeId: 'ChIJtest', name: 'Test', address: null,
    city: 'Barcelona', country: 'Spain', countryCode: 'ES',
    category: 'Food & Drink', primaryType: 'cafe', types: ['cafe'],
    lat: null, lng: null, sourceLists: ['Want to go'],
    mapsUrl: null, note: null, resolved: true,
    ...over,
  };
}

describe('group', () => {
  it('groups by category using "category" as the key', () => {
    const result = group(
      [place({ category: 'Food & Drink' }), place({ category: 'Outdoors' })],
      'category',
    );
    expect(result.groupBy).toBe('category');
    expect(result.totalPlaces).toBe(2);
    expect(result.results.map((g) => g['category'])).toEqual(['Food & Drink', 'Outdoors']);
  });

  it('groups by city using "city" as the key', () => {
    const result = group(
      [place({ city: 'Lisbon' }), place({ city: 'Barcelona' })],
      'city',
    );
    expect(result.results.map((g) => g['city'])).toEqual(['Barcelona', 'Lisbon']);
  });

  it('groups by country using "country" as the key', () => {
    const result = group(
      [place({ country: 'Portugal' }), place({ country: null, resolved: false })],
      'country',
    );
    expect(result.results.map((g) => g['country']).sort()).toEqual(['Portugal', 'Unknown']);
  });

  it('orders by descending count even when that fights alphabetical order', () => {
    // Porto must outrank Amsterdam on count alone, despite A < P. Using two
    // cities whose count and alphabetical order agree would pass under a
    // comparator that ignored count entirely.
    const result = group(
      [place({ city: 'Porto' }), place({ city: 'Amsterdam' }), place({ city: 'Porto' })],
      'city',
    );
    expect(result.results.map((g) => g['city'])).toEqual(['Porto', 'Amsterdam']);
    expect((result.results[0]!['places'] as ResolvedPlace[]).length).toBe(2);
  });

  it('breaks count ties alphabetically by key', () => {
    const result = group(
      [place({ city: 'Zurich' }), place({ city: 'Amsterdam' })],
      'city',
    );
    expect(result.results.map((g) => g['city'])).toEqual(['Amsterdam', 'Zurich']);
  });

  it('buckets null city under Unknown and counts unresolved places', () => {
    const result = group(
      [place({ city: null, resolved: false }), place({ city: 'Lisbon' })],
      'city',
    );
    expect(result.unresolvedCount).toBe(1);
    expect(result.results.map((g) => g['city']).sort()).toEqual(['Lisbon', 'Unknown']);
  });

  it('returns an empty result set for no places', () => {
    const result = group([], 'category');
    expect(result).toEqual({
      groupBy: 'category', totalPlaces: 0, unresolvedCount: 0, results: [],
    });
  });

  it('groups an uncategorized place under its readable primaryType', () => {
    const result = group(
      [place({ category: 'Unknown', primaryType: 'yak_rental' })],
      'category',
    );
    expect(result.results[0]!['category']).toBe('Yak Rental');
  });

  it('keeps Unknown for a place with no primaryType at all, with its own emoji, not the fallback', () => {
    const result = group(
      [place({ category: 'Unknown', primaryType: null, resolved: false })],
      'category',
    );
    expect(result.results[0]!['category']).toBe('Unknown');
    // Unknown (no type at all) and a fallback group (typed but uncurated) are
    // different states and must not carry the same marker.
    expect(result.results[0]!['emoji']).toBe('❓');
  });

  it('does not merge two different unmapped types into one group', () => {
    const result = group([
      place({ category: 'Unknown', primaryType: 'yak_rental' }),
      place({ category: 'Unknown', primaryType: 'art_studio' }),
    ], 'category');
    expect(result.results.map((g) => g['category']).sort()).toEqual(['Art Studio', 'Yak Rental']);
  });

  it('gives curated categories their own emoji and fallbacks the neutral one', () => {
    const result = group([
      place({ category: 'Food & Drink' }),
      place({ category: 'Unknown', primaryType: 'yak_rental' }),
    ], 'category');
    const byKey = Object.fromEntries(result.results.map((g) => [g['category'], g['emoji']]));
    expect(byKey['Food & Drink']).toBe('🍽️');
    expect(byKey['Yak Rental']).toBe('📌');
  });

  it('groups a pre-Phase-2 payload that has no types field', () => {
    // places.payload is a JSON column, so rows written before Task 1 have no
    // `types`. Grouping reads category and primaryType only, and must not
    // start assuming the newer shape.
    const legacy = { ...place({ category: 'Unknown', primaryType: 'yak_rental' }) };
    delete (legacy as { types?: unknown }).types;

    const result = group([legacy], 'category');
    expect(result.results[0]!['category']).toBe('Yak Rental');
  });

  it('gives city and country groups their dimension emoji', () => {
    expect(group([place({ city: 'Lisbon' })], 'city').results[0]!['emoji']).toBe('🏙️');
    expect(group([place({ country: 'Spain' })], 'country').results[0]!['emoji']).toBe('🌍');
  });
});
