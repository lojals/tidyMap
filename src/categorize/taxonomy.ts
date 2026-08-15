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

/**
 * Maps a Places API `primaryType` to one of the ten TidyMap categories.
 * Unmapped types are counted so gaps in the table surface from real data.
 */
export function categorize(primaryType: string | null | undefined): Category {
  if (!primaryType) return 'Unknown';

  const direct = TYPE_TO_CATEGORY[primaryType];
  if (direct) return direct;

  if (primaryType.endsWith('_restaurant')) return 'Food & Drink';

  unmapped.set(primaryType, (unmapped.get(primaryType) ?? 0) + 1);
  return 'Unknown';
}

export function unmappedTypeCounts(): ReadonlyMap<string, number> {
  return unmapped;
}

export function resetUnmappedCounts(): void {
  unmapped.clear();
}
