import { describe, it, expect, beforeEach } from 'vitest';
import {
  categorize, unmappedTypeCounts, resetUnmappedCounts, emojiForCategory, CATEGORIES,
} from './taxonomy.js';

describe('categorize', () => {
  beforeEach(() => resetUnmappedCounts());

  it.each([
    ['cafe', 'Food & Drink'],
    ['restaurant', 'Food & Drink'],
    ['bakery', 'Food & Drink'],
    ['night_club', 'Nightlife'],
    ['hotel', 'Lodging'],
    ['lodging', 'Lodging'],
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

  it('rescues an unmapped primaryType using a mappable secondary type', () => {
    expect(categorize('yak_rental', ['yak_rental', 'tourist_attraction', 'point_of_interest']))
      .toBe('Culture');
  });

  it('prefers primaryType over any secondary type', () => {
    // Disjoint categories on purpose: with the same type in both positions
    // this assertion passes under either priority order and pins nothing.
    expect(categorize('museum', ['park'])).toBe('Culture');
  });

  it('uses the FIRST mappable secondary type, not the last', () => {
    expect(categorize('yak_rental', ['museum', 'park'])).toBe('Culture');
  });

  it('returns Unknown when neither primaryType nor any secondary type maps', () => {
    expect(categorize('yak_rental', ['yak_rental', 'point_of_interest'])).toBe('Unknown');
  });

  it('applies the *_restaurant suffix rule to secondary types too', () => {
    expect(categorize('yak_rental', ['sushi_restaurant'])).toBe('Food & Drink');
  });

  it('counts the primaryType, not a rescued secondary type', () => {
    resetUnmappedCounts();
    categorize('yak_rental', ['tourist_attraction']);
    // Rescued: the place got a real category, so it is not a taxonomy gap.
    expect(unmappedTypeCounts().size).toBe(0);
  });

  it('counts the primaryType when nothing rescues it', () => {
    resetUnmappedCounts();
    categorize('yak_rental', ['point_of_interest']);
    expect([...unmappedTypeCounts().keys()]).toEqual(['yak_rental']);
  });

  it('tolerates a missing types argument (old persisted payloads)', () => {
    expect(categorize('cafe')).toBe('Food & Drink');
    expect(categorize('yak_rental')).toBe('Unknown');
    expect(categorize(null)).toBe('Unknown');
  });
});

describe('emojiForCategory', () => {
  it('returns a distinct emoji for every category', () => {
    // Sourced from the exported CATEGORIES rather than listed again here --
    // a hand-maintained duplicate is exactly how this list drifted before
    // (Task 2 removed one such copy; re-adding one here would reintroduce
    // the same risk of silently going stale as an eleventh category is added).
    const emojis = CATEGORIES.map(emojiForCategory);
    expect(emojis.every((e) => e.length > 0)).toBe(true);
    // Distinct so a glance at the UI actually distinguishes groups.
    expect(new Set(emojis).size).toBe(CATEGORIES.length);
  });
});
