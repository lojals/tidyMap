import { describe, it, expect } from 'vitest';
import { group } from './index.js';
import type { ResolvedPlace } from '../domain/types.js';

function place(over: Partial<ResolvedPlace>): ResolvedPlace {
  return {
    placeId: 'ChIJtest', name: 'Test', address: null,
    city: 'Barcelona', country: 'Spain', countryCode: 'ES',
    category: 'Food & Drink', primaryType: 'cafe',
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

  it('orders groups by descending place count', () => {
    const result = group(
      [place({ city: 'Lisbon' }), place({ city: 'Porto' }), place({ city: 'Lisbon' })],
      'city',
    );
    expect(result.results[0]!['city']).toBe('Lisbon');
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
});
