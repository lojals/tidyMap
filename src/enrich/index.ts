import type { ResolvedPlace, SavedItem } from '../domain/types.js';
import { categorize } from '../categorize/taxonomy.js';
import { extractCity, extractCountry } from './address.js';
import { searchText, type PlacesDeps, type PlaceSearchResult } from './places-client.js';

function searchTextFor(item: SavedItem): string {
  return item.address ? `${item.title} ${item.address}` : item.title;
}

function toResolvedPlace(item: SavedItem, match: PlaceSearchResult | null): ResolvedPlace {
  if (!match) {
    return {
      placeId: null,
      name: item.title,
      address: item.address ?? null,
      city: null,
      country: null,
      countryCode: null,
      category: 'Unknown',
      primaryType: null,
      lat: item.lat ?? null,
      lng: item.lng ?? null,
      sourceLists: [item.sourceList],
      mapsUrl: item.mapsUrl ?? null,
      note: item.note ?? null,
      resolved: false,
    };
  }

  const country = extractCountry(match.addressComponents);

  return {
    placeId: match.id,
    name: match.displayName?.text ?? item.title,
    address: match.formattedAddress ?? item.address ?? null,
    city: extractCity(match.addressComponents),
    country: country?.name ?? null,
    countryCode: country?.code ?? null,
    category: categorize(match.primaryType),
    primaryType: match.primaryType ?? null,
    lat: match.location?.latitude ?? item.lat ?? null,
    lng: match.location?.longitude ?? item.lng ?? null,
    sourceLists: [item.sourceList],
    mapsUrl: item.mapsUrl ?? null,
    note: item.note ?? null,
    resolved: true,
  };
}

/**
 * Resolves every saved item through the Places API, then deduplicates.
 *
 * A place can legitimately appear both starred and in a list, so identical
 * placeIds are merged with their source lists combined. Unresolved items are
 * never merged — without a placeId there is no evidence they are the same place.
 * Results are cached per query so repeats within a run cost nothing.
 */
export async function enrich(items: SavedItem[], deps: PlacesDeps): Promise<ResolvedPlace[]> {
  const cache = new Map<string, PlaceSearchResult | null>();
  const byPlaceId = new Map<string, ResolvedPlace>();
  const unresolved: ResolvedPlace[] = [];

  for (const item of items) {
    const text = searchTextFor(item);
    const cacheKey = `${text.toLowerCase()}|${item.lat ?? ''}|${item.lng ?? ''}`;

    let match: PlaceSearchResult | null;
    if (cache.has(cacheKey)) {
      match = cache.get(cacheKey) ?? null;
    } else {
      match = await searchText(
        { text, ...(item.lat !== undefined ? { lat: item.lat } : {}), ...(item.lng !== undefined ? { lng: item.lng } : {}) },
        deps,
      );
      cache.set(cacheKey, match);
    }

    const place = toResolvedPlace(item, match);

    if (!place.placeId) {
      unresolved.push(place);
      continue;
    }

    const existing = byPlaceId.get(place.placeId);
    if (existing) {
      for (const list of place.sourceLists) {
        if (!existing.sourceLists.includes(list)) existing.sourceLists.push(list);
      }
      existing.note ??= place.note;
    } else {
      byPlaceId.set(place.placeId, place);
    }
  }

  return [...byPlaceId.values(), ...unresolved];
}
