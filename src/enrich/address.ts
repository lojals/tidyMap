/** Places API (New) address component. Note longText/shortText, not long_name/short_name. */
export interface AddressComponent {
  longText: string;
  shortText: string;
  types: string[];
}

/**
 * Ordered fallback chain. `locality` is simply absent from UK addresses and
 * several other countries, so this chain is required, not defensive.
 */
const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_2'] as const;

export function extractCity(components: AddressComponent[] | undefined): string | null {
  if (!components) return null;

  for (const type of CITY_TYPES) {
    const match = components.find((component) => component.types.includes(type));
    if (match) return match.longText;
  }
  return null;
}

export function extractCountry(
  components: AddressComponent[] | undefined,
): { name: string; code: string } | null {
  if (!components) return null;

  const match = components.find((component) => component.types.includes('country'));
  return match ? { name: match.longText, code: match.shortText } : null;
}
