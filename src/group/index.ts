import type { GroupBy, GroupedResult, PlaceGroup, ResolvedPlace } from '../domain/types.js';

function keyFor(place: ResolvedPlace, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'category': return place.category;
    case 'city': return place.city ?? 'Unknown';
    case 'country': return place.country ?? 'Unknown';
  }
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
    .map(([key, bucketPlaces]) => ({ [groupBy]: key, places: bucketPlaces }));

  return {
    groupBy,
    totalPlaces: places.length,
    unresolvedCount: places.filter((p) => !p.resolved).length,
    results,
  };
}
