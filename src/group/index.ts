import {
  emojiForCategory, FALLBACK_EMOJI, CITY_EMOJI, COUNTRY_EMOJI,
} from '../categorize/taxonomy.js';
import type { Category, GroupBy, GroupedResult, PlaceGroup, ResolvedPlace } from '../domain/types.js';

const CURATED: ReadonlySet<string> = new Set<Category>([
  'Food & Drink', 'Nightlife', 'Lodging', 'Shopping', 'Outdoors',
  'Culture', 'Entertainment', 'Services', 'Transport', 'Unknown',
]);

/** `yak_rental` -> `Yak Rental`. */
function readableType(type: string): string {
  return type
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function keyFor(place: ResolvedPlace, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'category':
      // A place Google typed but our table does not cover becomes its own
      // group rather than joining one useless Unknown pile. Places with no
      // type at all have nothing better to say and stay Unknown.
      if (place.category !== 'Unknown') return place.category;
      return place.primaryType ? readableType(place.primaryType) : 'Unknown';
    case 'city': return place.city ?? 'Unknown';
    case 'country': return place.country ?? 'Unknown';
  }
}

function emojiFor(key: string, groupBy: GroupBy): string {
  if (groupBy === 'city') return CITY_EMOJI;
  if (groupBy === 'country') return COUNTRY_EMOJI;
  return CURATED.has(key) ? emojiForCategory(key as Category) : FALLBACK_EMOJI;
}

/**
 * Buckets places by the requested dimension. The group key is named after that
 * dimension, so grouping by city yields `{ city: "Lisbon", places: [...] }`.
 * Groups are ordered by descending size, ties broken alphabetically, so output
 * is stable across runs.
 */
export function group(places: ResolvedPlace[], groupBy: GroupBy): GroupedResult {
  const buckets = new Map<string, ResolvedPlace[]>();

  for (const place of places) {
    const key = keyFor(place, groupBy);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(place);
    else buckets.set(key, [place]);
  }

  const results: PlaceGroup[] = [...buckets.entries()]
    .sort(([aKey, aPlaces], [bKey, bPlaces]) =>
      bPlaces.length - aPlaces.length || aKey.localeCompare(bKey))
    .map(([key, bucketPlaces]) => ({
      [groupBy]: key,
      emoji: emojiFor(key, groupBy),
      places: bucketPlaces,
    }));

  return {
    groupBy,
    totalPlaces: places.length,
    unresolvedCount: places.filter((p) => !p.resolved).length,
    results,
  };
}
