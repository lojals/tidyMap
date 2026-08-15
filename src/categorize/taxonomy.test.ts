import { describe, it, expect, beforeEach } from 'vitest';
import { categorize, unmappedTypeCounts, resetUnmappedCounts } from './taxonomy.js';

describe('categorize', () => {
  beforeEach(() => resetUnmappedCounts());

  it.each([
    ['cafe', 'Food & Drink'],
    ['restaurant', 'Food & Drink'],
    ['bakery', 'Food & Drink'],
    ['night_club', 'Nightlife'],
    ['hotel', 'Lodging'],
    ['book_store', 'Shopping'],
    ['park', 'Outdoors'],
    ['museum', 'Culture'],
    ['movie_theater', 'Entertainment'],
    ['pharmacy', 'Services'],
    ['airport', 'Transport'],
  ])('maps %s to %s', (type, expected) => {
    expect(categorize(type)).toBe(expected);
  });

  it('maps any *_restaurant suffix to Food & Drink', () => {
    expect(categorize('italian_restaurant')).toBe('Food & Drink');
    expect(categorize('sushi_restaurant')).toBe('Food & Drink');
  });

  it('returns Unknown for null or undefined', () => {
    expect(categorize(null)).toBe('Unknown');
    expect(categorize(undefined)).toBe('Unknown');
  });

  it('returns Unknown for an unmapped type and counts it', () => {
    expect(categorize('yak_rental')).toBe('Unknown');
    expect(categorize('yak_rental')).toBe('Unknown');
    expect(unmappedTypeCounts().get('yak_rental')).toBe(2);
  });

  it('does not count null as an unmapped type', () => {
    categorize(null);
    expect(unmappedTypeCounts().size).toBe(0);
  });
});
