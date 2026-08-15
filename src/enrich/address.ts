/**
 * Places API (New) address component. Note longText/shortText, not
 * long_name/short_name.
 *
 * `types` is optional because the caller (places-client.ts) casts the raw
 * HTTP response with `as` and never validates it at runtime -- Google's
 * actual response is not guaranteed to match this shape. The type reflects
 * that: every field here may be genuinely absent on a live response, so
 * every read site below guards accordingly instead of trusting the cast.
 */
export interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

/**
 * Ordered fallback chain. `locality` is simply absent from UK addresses and
 * several other countries, so this chain is required, not defensive.
 */
const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_2'] as const;

export function extractCity(components: AddressComponent[] | undefined): string | null {
  if (!components) return null;

  for (const type of CITY_TYPES) {
    const match = components.find((component) => component.types?.includes(type));
    // A component that matches on `types` but is missing `longText` does not
    // carry a usable city name. Falling through to the next type in the
    // chain (rather than returning `match.longText`, which would be
    // `undefined`) keeps the return type honest: `string | null`, never
    // `string | undefined`.
    if (match?.longText) return match.longText;
  }
  return null;
}

export function extractCountry(
  components: AddressComponent[] | undefined,
): { name: string; code: string } | null {
  if (!components) return null;

  const match = components.find((component) => component.types?.includes('country'));
  if (!match?.longText || !match.shortText) return null;
  return { name: match.longText, code: match.shortText };
}
