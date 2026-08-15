import type { AddressComponent } from './address.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.primaryType',
  'places.types',
  'places.location',
  'places.addressComponents',
].join(',');

export interface PlaceSearchResult {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  primaryType?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
  addressComponents?: AddressComponent[];
}

export interface SearchQuery {
  text: string;
  lat?: number;
  lng?: number;
}

export interface PlacesDeps {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves free text to a single place. Returns null for "no match" and for
 * transient failures that survive retries — both mean "unresolved", which is a
 * normal outcome, not an error. 401/403/400 throw instead, because those are a
 * missing billing account or a bad key and every subsequent call would fail the
 * same way. Google returns 400 (not 401/403) with status API_KEY_INVALID for a
 * bad key, so 400 must be treated as fatal too: searchText builds every request
 * itself from a fixed field mask, so a 400 here is a configuration fault, never
 * a per-item data fault, and letting it fall through to `return null` would
 * silently mark every place unresolved instead of failing loudly.
 */
export async function searchText(
  query: SearchQuery,
  deps: PlacesDeps,
): Promise<PlaceSearchResult | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? 3;

  const body: Record<string, unknown> = {
    textQuery: query.text,
    maxResultCount: 1,
    languageCode: 'en',
  };

  if (query.lat !== undefined && query.lng !== undefined) {
    body['locationBias'] = {
      circle: { center: { latitude: query.lat, longitude: query.lng }, radius: 500 },
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': deps.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const json = (await response.json()) as { places?: PlaceSearchResult[] };
      return json.places?.[0] ?? null;
    }

    if (response.status === 401 || response.status === 403 || response.status === 400) {
      const detail = await response.text();
      throw new Error(
        `Places API rejected the request with ${response.status}. ` +
        `Check that GOOGLE_PLACES_API_KEY is valid and billing is enabled on the project. ` +
        `Google said: ${detail.slice(0, 300)}`,
      );
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxRetries) return null;

    await sleep(2 ** attempt * 250);
  }

  return null;
}
