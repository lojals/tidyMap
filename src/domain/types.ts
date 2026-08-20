export type Category =
  | 'Food & Drink'
  | 'Nightlife'
  | 'Lodging'
  | 'Shopping'
  | 'Outdoors'
  | 'Culture'
  | 'Entertainment'
  | 'Services'
  | 'Transport'
  | 'Unknown';

export type GroupBy = 'category' | 'city' | 'country';

/** A place as it comes out of the Portability export, before enrichment. */
export interface SavedItem {
  sourceId: string;
  title: string;
  address?: string;
  lat?: number;
  lng?: number;
  mapsUrl?: string;
  note?: string;
  sourceList: string;
}

/** A place after Places API resolution. Always produced, even on failure. */
export interface ResolvedPlace {
  placeId: string | null;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  category: Category;
  primaryType: string | null;
  /**
   * Raw Places `types[]`. May be absent on places persisted before Phase 2 --
   * `places.payload` is a JSON column, so old rows were never migrated. Treat
   * it as possibly undefined when reading stored payloads.
   */
  types?: string[];
  lat: number | null;
  lng: number | null;
  sourceLists: string[];
  mapsUrl: string | null;
  note: string | null;
  resolved: boolean;
}

/** One group. The key is named after the dimension grouped by. */
export type PlaceGroup = {
  [key: string]: string | ResolvedPlace[];
  emoji: string;
  places: ResolvedPlace[];
};

export interface GroupedResult {
  groupBy: GroupBy;
  totalPlaces: number;
  unresolvedCount: number;
  results: PlaceGroup[];
}

/** One text file out of an unpacked export archive. */
export interface ExportFile {
  path: string;
  content: string;
}
