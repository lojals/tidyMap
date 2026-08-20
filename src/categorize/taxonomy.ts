import type { Category } from '../domain/types.js';

const TYPE_TO_CATEGORY: Record<string, Category> = {
  restaurant: 'Food & Drink',
  cafe: 'Food & Drink',
  coffee_shop: 'Food & Drink',
  bakery: 'Food & Drink',
  bar: 'Food & Drink',
  ice_cream_shop: 'Food & Drink',
  meal_takeaway: 'Food & Drink',
  meal_delivery: 'Food & Drink',

  night_club: 'Nightlife',
  pub: 'Nightlife',
  casino: 'Nightlife',
  comedy_club: 'Nightlife',

  hotel: 'Lodging',
  hostel: 'Lodging',
  guest_house: 'Lodging',
  campground: 'Lodging',
  resort_hotel: 'Lodging',
  bed_and_breakfast: 'Lodging',

  store: 'Shopping',
  market: 'Shopping',
  shopping_mall: 'Shopping',
  book_store: 'Shopping',
  clothing_store: 'Shopping',
  grocery_store: 'Shopping',
  supermarket: 'Shopping',

  park: 'Outdoors',
  beach: 'Outdoors',
  hiking_area: 'Outdoors',
  national_park: 'Outdoors',
  garden: 'Outdoors',
  campsite: 'Outdoors',

  museum: 'Culture',
  art_gallery: 'Culture',
  historical_landmark: 'Culture',
  tourist_attraction: 'Culture',
  church: 'Culture',
  mosque: 'Culture',
  synagogue: 'Culture',
  hindu_temple: 'Culture',
  library: 'Culture',

  movie_theater: 'Entertainment',
  stadium: 'Entertainment',
  amusement_park: 'Entertainment',
  zoo: 'Entertainment',
  aquarium: 'Entertainment',
  concert_hall: 'Entertainment',

  bank: 'Services',
  atm: 'Services',
  hospital: 'Services',
  pharmacy: 'Services',
  gym: 'Services',
  spa: 'Services',
  hair_salon: 'Services',
  post_office: 'Services',

  airport: 'Transport',
  train_station: 'Transport',
  subway_station: 'Transport',
  bus_station: 'Transport',
  parking: 'Transport',
  ferry_terminal: 'Transport',
};

const unmapped = new Map<string, number>();

/** One lookup attempt against the table, including the *_restaurant suffix rule. */
function lookup(type: string | null | undefined): Category | undefined {
  if (!type) return undefined;

  const direct = TYPE_TO_CATEGORY[type];
  if (direct) return direct;

  if (type.endsWith('_restaurant')) return 'Food & Drink';

  return undefined;
}

/**
 * Maps a place to one of the ten TidyMap categories.
 *
 * `primaryType` wins. Failing that, the first mappable entry in `types[]`
 * rescues the place -- Google often reports a useless primary type alongside a
 * perfectly good secondary one (`yak_rental, tourist_attraction`).
 *
 * Only a place that ends up Unknown is counted as a taxonomy gap, and it is
 * counted under its `primaryType`. A rescued place is not a gap: it got a real
 * category, and listing it would make the warnings report unactionable.
 */
export function categorize(
  primaryType: string | null | undefined,
  types?: readonly string[] | null,
): Category {
  const direct = lookup(primaryType);
  if (direct) return direct;

  for (const type of types ?? []) {
    const rescued = lookup(type);
    if (rescued) return rescued;
  }

  if (primaryType) {
    unmapped.set(primaryType, (unmapped.get(primaryType) ?? 0) + 1);
  }
  return 'Unknown';
}

export function unmappedTypeCounts(): ReadonlyMap<string, number> {
  return unmapped;
}

export function resetUnmappedCounts(): void {
  unmapped.clear();
}

/** Neutral marker for groups that are not a curated category. */
export const FALLBACK_EMOJI = '📌';
export const CITY_EMOJI = '🏙️';
export const COUNTRY_EMOJI = '🌍';

const CATEGORY_EMOJI: Record<Category, string> = {
  'Food & Drink': '🍽️',
  Nightlife: '🍸',
  Lodging: '🛏️',
  Shopping: '🛍️',
  Outdoors: '🌳',
  Culture: '🏛️',
  Entertainment: '🎭',
  Services: '🏥',
  Transport: '🚉',
  Unknown: '❓',
};

export function emojiForCategory(category: Category): string {
  return CATEGORY_EMOJI[category];
}
