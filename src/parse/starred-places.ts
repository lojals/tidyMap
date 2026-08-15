import type { SavedItem } from '../domain/types.js';

interface Feature {
  geometry?: { coordinates?: unknown };
  properties?: {
    name?: string;
    address?: string;
    google_maps_url?: string;
    location?: { name?: string; address?: string };
  };
}

/**
 * Parses the starred-places GeoJSON. Two property shapes are handled because
 * the Portability schema documents flat `name`/`address` while real exports
 * nest them under `location`.
 */
export function parseStarredPlacesGeoJson(json: string): SavedItem[] {
  const parsed = JSON.parse(json) as { features?: Feature[] };
  const features = parsed.features ?? [];

  return features.flatMap((feature, index) => {
    const props = feature.properties ?? {};
    const title = props.location?.name ?? props.name;
    if (!title) return [];

    const address = props.location?.address ?? props.address;
    const coords = feature.geometry?.coordinates;
    // GeoJSON is [longitude, latitude] — that order.
    const hasCoords = Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number';

    return [{
      sourceId: `starred:${index}`,
      title,
      ...(address ? { address } : {}),
      ...(hasCoords ? { lng: coords[0] as number, lat: coords[1] as number } : {}),
      ...(props.google_maps_url ? { mapsUrl: props.google_maps_url } : {}),
      sourceList: 'Starred places',
    }];
  });
}
