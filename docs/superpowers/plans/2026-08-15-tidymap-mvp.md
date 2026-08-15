# TidyMap Phase 1 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backend that authenticates a user with Google, exports their saved Maps places via the Data Portability API, resolves each to a PlaceID with city/country/category via the Places API, and returns them grouped as JSON.

**Architecture:** Nine modules in a single TypeScript package. Everything after parsing is pure and network-free, so the interesting logic is tested without touching Google. A fixture mode replaces the Portability and Places calls with committed sample data, because Portability authorization is one-time-use and every real run costs a browser consent round-trip.

**Tech Stack:** Node 22 LTS, TypeScript 5.6+ (ESM), Fastify 5, Drizzle ORM + better-sqlite3, google-auth-library, fflate, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-tidymap-mvp-design.md`

## Global Constraints

- **ESM only.** `"type": "module"` in package.json. All relative imports MUST carry a `.js` extension (`import { x } from './foo.js'`) even though the source is `.ts`. TypeScript does not rewrite these.
- **Node 22 LTS minimum.** Uses built-in `fetch`.
- **Category values are exactly these ten strings**, including the ampersand and spacing: `Food & Drink`, `Nightlife`, `Lodging`, `Shopping`, `Outdoors`, `Culture`, `Entertainment`, `Services`, `Transport`, `Unknown`.
- **Places API (New) field names** are `longText` / `shortText`, NOT the legacy `long_name` / `short_name`.
- **GeoJSON coordinates are `[longitude, latitude]`** — that order, not lat/lng.
- **Never drop a saved place.** Anything that fails resolution is kept with `resolved: false` and `category: "Unknown"`.
- **The 20-item cap is applied before enrichment**, never after. Enrichment is the only stage that costs money.
- **No secrets in the repo.** All credentials via `.env`, which is gitignored.
- Every task ends with a commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/types.ts` | The JSON contract. Lifted to `packages/shared` when a frontend arrives |
| `src/categorize/taxonomy.ts` | `primaryType` → `Category` lookup + unmapped counter |
| `src/group/index.ts` | `(ResolvedPlace[], GroupBy)` → `GroupedResult` |
| `src/enrich/address.ts` | `addressComponents` → city / country. Pure |
| `src/enrich/places-client.ts` | Places API `searchText` HTTP client with retry |
| `src/enrich/index.ts` | `SavedItem[]` → `ResolvedPlace[]`, cache, dedupe |
| `src/parse/saved-collections.ts` | Collections CSV → `SavedItem[]` |
| `src/parse/starred-places.ts` | Starred GeoJSON → `SavedItem[]` |
| `src/parse/index.ts` | Merge both sources, stable ordering, cap |
| `src/db/schema.ts` | Drizzle table definitions |
| `src/db/client.ts` | SQLite connection + migration runner |
| `src/portability/client.ts` | initiate / getState / reset |
| `src/archive/download.ts` | Fetch signed URLs, unzip, persist |
| `src/auth/oauth.ts` | OAuth code flow, token storage/refresh |
| `src/auth/routes.ts` | `/auth/*` endpoints |
| `src/jobs/pipeline.ts` | Orchestrates the seven pipeline stages |
| `src/jobs/routes.ts` | `/extractions/*` endpoints |
| `src/config.ts` | Env parsing, fail-fast validation |
| `src/context.ts` | `AppContext` — the `{ db, config }` handle passed to routes and the pipeline |
| `src/server.ts` | Fastify assembly + entrypoint |
| `fixtures/` | Sample export + recorded Places responses |

---

## Task 1: Scaffold, domain types, and categorization

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
  (no `vitest.config.ts` — Vitest's default include glob already covers `src/**/*.test.ts`)
- Create: `src/domain/types.ts`, `src/categorize/taxonomy.ts`
- Test: `src/categorize/taxonomy.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Category`, `GroupBy`, `SavedItem`, `ResolvedPlace`, `GroupedResult` types; `categorize(primaryType: string | null | undefined): Category`; `unmappedTypeCounts(): ReadonlyMap<string, number>`; `resetUnmappedCounts(): void`

- [ ] **Step 1: Initialize the project**

```bash
npm init -y
npm pkg set type=module
npm pkg set scripts.test="vitest run"
npm pkg set scripts.dev="tsx watch src/server.ts"
npm pkg set scripts.build="tsc"
npm install -D typescript@^5.6 vitest@^2 tsx @types/node
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `.gitignore` and `.env.example`**

`.gitignore`:
```
node_modules/
dist/
.env
*.db
*.db-journal
data/
```

`.env.example`:
```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_PLACES_API_KEY=
DATABASE_URL=./tidymap.db
PORTABILITY_SOURCE=live
PORT=3000
```

- [ ] **Step 4: Write `src/domain/types.ts`**

```ts
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
```

- [ ] **Step 5: Write the failing test**

`src/categorize/taxonomy.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { categorize, unmappedTypeCounts, resetUnmappedCounts } from './taxonomy.js';

describe('categorize', () => {
  beforeEach(() => resetUnmappedCounts());

  it.each([
    ['cafe', 'Food & Drink'],
    ['restaurant', 'Food & Drink'],
    ['bakery', 'Food & Drink'],
    ['night_club', 'Nightlife'],
    ['hotel', 'Lodging'],
    ['book_store', 'Shopping'],
    ['park', 'Outdoors'],
    ['museum', 'Culture'],
    ['movie_theater', 'Entertainment'],
    ['pharmacy', 'Services'],
    ['airport', 'Transport'],
  ])('maps %s to %s', (type, expected) => {
    expect(categorize(type)).toBe(expected);
  });

  it('maps any *_restaurant suffix to Food & Drink', () => {
    expect(categorize('italian_restaurant')).toBe('Food & Drink');
    expect(categorize('sushi_restaurant')).toBe('Food & Drink');
  });

  it('returns Unknown for null or undefined', () => {
    expect(categorize(null)).toBe('Unknown');
    expect(categorize(undefined)).toBe('Unknown');
  });

  it('returns Unknown for an unmapped type and counts it', () => {
    expect(categorize('yak_rental')).toBe('Unknown');
    expect(categorize('yak_rental')).toBe('Unknown');
    expect(unmappedTypeCounts().get('yak_rental')).toBe(2);
  });

  it('does not count null as an unmapped type', () => {
    categorize(null);
    expect(unmappedTypeCounts().size).toBe(0);
  });
});
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npx vitest run src/categorize/taxonomy.test.ts`
Expected: FAIL — cannot resolve `./taxonomy.js`

- [ ] **Step 7: Write `src/categorize/taxonomy.ts`**

```ts
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
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npx vitest run src/categorize/taxonomy.test.ts`
Expected: PASS, all cases green

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example src/
git commit -m "feat: scaffold project with domain types and categorization"
```

---

## Task 2: Grouping

**Files:**
- Create: `src/group/index.ts`
- Test: `src/group/index.test.ts`

**Interfaces:**
- Consumes: `ResolvedPlace`, `GroupBy`, `GroupedResult`, `PlaceGroup` from `src/domain/types.js`
- Produces: `group(places: ResolvedPlace[], groupBy: GroupBy): GroupedResult`

- [ ] **Step 1: Write the failing test**

`src/group/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { group } from './index.js';
import type { ResolvedPlace } from '../domain/types.js';

function place(over: Partial<ResolvedPlace>): ResolvedPlace {
  return {
    placeId: 'ChIJtest', name: 'Test', address: null,
    city: 'Barcelona', country: 'Spain', countryCode: 'ES',
    category: 'Food & Drink', primaryType: 'cafe',
    lat: null, lng: null, sourceLists: ['Want to go'],
    mapsUrl: null, note: null, resolved: true,
    ...over,
  };
}

describe('group', () => {
  it('groups by category using "category" as the key', () => {
    const result = group(
      [place({ category: 'Food & Drink' }), place({ category: 'Outdoors' })],
      'category',
    );
    expect(result.groupBy).toBe('category');
    expect(result.totalPlaces).toBe(2);
    expect(result.results.map((g) => g['category'])).toEqual(['Food & Drink', 'Outdoors']);
  });

  it('groups by city using "city" as the key', () => {
    const result = group(
      [place({ city: 'Lisbon' }), place({ city: 'Barcelona' })],
      'city',
    );
    expect(result.results.map((g) => g['city'])).toEqual(['Barcelona', 'Lisbon']);
  });

  it('orders by descending count even when that fights alphabetical order', () => {
    // Porto must outrank Amsterdam on count alone, despite A < P. Using two
    // cities whose count and alphabetical order agree would pass under a
    // comparator that ignored count entirely.
    const result = group(
      [place({ city: 'Porto' }), place({ city: 'Amsterdam' }), place({ city: 'Porto' })],
      'city',
    );
    expect(result.results.map((g) => g['city'])).toEqual(['Porto', 'Amsterdam']);
    expect((result.results[0]!['places'] as ResolvedPlace[]).length).toBe(2);
  });

  it('groups by country using "country" as the key', () => {
    const result = group(
      [place({ country: 'Portugal' }), place({ country: null, resolved: false })],
      'country',
    );
    expect(result.results.map((g) => g['country']).sort()).toEqual(['Portugal', 'Unknown']);
  });

  it('breaks count ties alphabetically by key', () => {
    const result = group(
      [place({ city: 'Zurich' }), place({ city: 'Amsterdam' })],
      'city',
    );
    expect(result.results.map((g) => g['city'])).toEqual(['Amsterdam', 'Zurich']);
  });

  it('buckets null city under Unknown and counts unresolved places', () => {
    const result = group(
      [place({ city: null, resolved: false }), place({ city: 'Lisbon' })],
      'city',
    );
    expect(result.unresolvedCount).toBe(1);
    expect(result.results.map((g) => g['city']).sort()).toEqual(['Lisbon', 'Unknown']);
  });

  it('returns an empty result set for no places', () => {
    const result = group([], 'category');
    expect(result).toEqual({
      groupBy: 'category', totalPlaces: 0, unresolvedCount: 0, results: [],
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/group/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`

- [ ] **Step 3: Write `src/group/index.ts`**

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/group/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/group/
git commit -m "feat: add grouping by category, city, and country"
```

---

## Task 3: Address component extraction

**Files:**
- Create: `src/enrich/address.ts`
- Test: `src/enrich/address.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `AddressComponent` interface (`{ longText: string; shortText: string; types: string[] }`); `extractCity(components: AddressComponent[] | undefined): string | null`; `extractCountry(components: AddressComponent[] | undefined): { name: string; code: string } | null`

- [ ] **Step 1: Write the failing test**

`src/enrich/address.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { extractCity, extractCountry, type AddressComponent } from './address.js';

const c = (longText: string, shortText: string, ...types: string[]): AddressComponent =>
  ({ longText, shortText, types });

describe('extractCity', () => {
  it('uses locality when present (US)', () => {
    expect(extractCity([
      c('San Francisco', 'SF', 'locality', 'political'),
      c('California', 'CA', 'administrative_area_level_1'),
    ])).toBe('San Francisco');
  });

  it('falls back to postal_town when locality is absent (UK)', () => {
    expect(extractCity([
      c('London', 'London', 'postal_town'),
      c('Greater London', 'Greater London', 'administrative_area_level_2'),
    ])).toBe('London');
  });

  it('falls back to administrative_area_level_2 when both are absent', () => {
    expect(extractCity([
      c('Girona', 'Girona', 'administrative_area_level_2'),
    ])).toBe('Girona');
  });

  it('prefers locality over postal_town when both exist', () => {
    expect(extractCity([
      c('Brighton', 'Brighton', 'postal_town'),
      c('Hove', 'Hove', 'locality'),
    ])).toBe('Hove');
  });

  it('uses locality for Japan, not administrative_area_level_1', () => {
    expect(extractCity([
      c('Shibuya City', 'Shibuya', 'locality'),
      c('Tokyo', 'Tokyo', 'administrative_area_level_1'),
    ])).toBe('Shibuya City');
  });

  it('never falls back to administrative_area_level_1', () => {
    // Load-bearing. Every other fixture that carries administrative_area_level_1
    // also carries locality, so appending it to CITY_TYPES would pass every
    // other test in this file. This is the only case that would fail.
    expect(extractCity([
      c('Tokyo', 'Tokyo', 'administrative_area_level_1'),
      c('Japan', 'JP', 'country'),
    ])).toBeNull();
  });

  it('returns null when no city-like component exists', () => {
    expect(extractCity([c('Spain', 'ES', 'country')])).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractCity(undefined)).toBeNull();
  });
});

describe('extractCountry', () => {
  it('returns long name and ISO short code', () => {
    expect(extractCountry([c('Spain', 'ES', 'country', 'political')]))
      .toEqual({ name: 'Spain', code: 'ES' });
  });

  it('returns null when there is no country component', () => {
    expect(extractCountry([c('Barcelona', 'Barcelona', 'locality')])).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractCountry(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/enrich/address.test.ts`
Expected: FAIL — cannot resolve `./address.js`

- [ ] **Step 3: Write `src/enrich/address.ts`**

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/enrich/address.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/enrich/address.ts src/enrich/address.test.ts
git commit -m "feat: extract city and country from Places address components"
```

---

## Task 4: Parsers and fixtures

**Files:**
- Create: `src/parse/saved-collections.ts`, `src/parse/starred-places.ts`, `src/parse/index.ts`
- Create: `fixtures/saved-collections/Want to go.csv`, `fixtures/starred-places/Starred places.json`
- Test: `src/parse/saved-collections.test.ts`, `src/parse/starred-places.test.ts`, `src/parse/index.test.ts`

**Interfaces:**
- Consumes: `SavedItem`, `ExportFile` from `src/domain/types.js`
- Produces: `parseSavedCollectionsCsv(csv: string, listName: string): SavedItem[]`; `parseStarredPlacesGeoJson(json: string): SavedItem[]`; `parseExport(files: ExportFile[], limit: number): SavedItem[]`; `skippedFiles(): ReadonlyMap<string, string>`; `resetSkippedFiles(): void`

- [ ] **Step 1: Install the CSV parser**

```bash
npm install csv-parse
```

- [ ] **Step 2: Write the saved-collections fixture**

`fixtures/saved-collections/Want to go.csv`:
Maps URLs contain commas in the `@lat,lng,zoom` segment, so the URL column
MUST be quoted. Unquoted, csv-parse truncates the URL and spills the remainder
into `tags` and `comment`, which silently corrupts the `note` fallback.

```csv
title,note,item_content_url,tags,comment
Satan's Coffee Corner,cortado,"https://www.google.com/maps/place/Satan's+Coffee+Corner/@41.3825,2.1769,17z/",,
Bar Cañete,tapas,"https://www.google.com/maps/place/Bar+Ca%C3%B1ete/@41.3789,2.1723,17z/",,
Nike Air Max,,https://www.google.com/shopping/product/12345,,
Antarctica blog,,https://traveltriangle.com/blog/places-to-visit-in-antarctica/,,
Park Güell,,"https://www.google.com/maps/place/Park+G%C3%BCell/@41.4145,2.1527,17z/",,
```

- [ ] **Step 3: Write the failing CSV parser test**

`src/parse/saved-collections.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSavedCollectionsCsv } from './saved-collections.js';

const csv = readFileSync('fixtures/saved-collections/Want to go.csv', 'utf8');

describe('parseSavedCollectionsCsv', () => {
  it('keeps only Google Maps place URLs', () => {
    const items = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(items.map((i) => i.title)).toEqual([
      "Satan's Coffee Corner", 'Bar Cañete', 'Park Güell',
    ]);
  });

  it('carries note, mapsUrl, and sourceList through', () => {
    const [first] = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(first!.note).toBe('cortado');
    expect(first!.sourceList).toBe('Want to go');
    expect(first!.mapsUrl).toContain('/maps/place/');
  });

  it('produces no coordinates — collections CSV has none', () => {
    const [first] = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(first!.lat).toBeUndefined();
    expect(first!.lng).toBeUndefined();
  });

  it('accepts the legacy Takeout header casing', () => {
    const legacy = 'Title,Note,URL,Comment\nTupinamba,,https://www.google.com/maps/place/Tupinamba/,\n';
    const items = parseSavedCollectionsCsv(legacy, 'Favorites');
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Tupinamba');
  });

  it('returns an empty array for a header-only file', () => {
    expect(parseSavedCollectionsCsv('title,note,item_content_url\n', 'Empty')).toEqual([]);
  });

  it('assigns stable sourceIds derived from list name and row index', () => {
    const items = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(items[0]!.sourceId).toBe('collection:Want to go:0');
  });
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `npx vitest run src/parse/saved-collections.test.ts`
Expected: FAIL — cannot resolve `./saved-collections.js`

- [ ] **Step 5: Write `src/parse/saved-collections.ts`**

```ts
import { parse } from 'csv-parse/sync';
import type { SavedItem } from '../domain/types.js';

/** Header names differ between the Portability schema and legacy Takeout exports. */
const FIELD_ALIASES: Record<string, string[]> = {
  title: ['title'],
  note: ['note'],
  url: ['item_content_url', 'url'],
  comment: ['comment'],
};

function pick(row: Record<string, string>, field: keyof typeof FIELD_ALIASES): string {
  for (const alias of FIELD_ALIASES[field]!) {
    const value = row[alias];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function isMapsPlaceUrl(url: string): boolean {
  if (!url) return false;
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'maps.app.goo.gl' || hostname === 'goo.gl') return true;
    if (!hostname.endsWith('google.com')) return false;
    return pathname.startsWith('/maps/');
  } catch {
    return false;
  }
}

/**
 * Parses one saved-collection CSV. Collections can contain shopping products,
 * images, searches and arbitrary web pages alongside places — everything that
 * is not a Maps place URL is dropped here.
 */
export function parseSavedCollectionsCsv(csv: string, listName: string): SavedItem[] {
  const rows = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return rows.flatMap((row, index) => {
    const url = pick(row, 'url');
    if (!isMapsPlaceUrl(url)) return [];

    const note = pick(row, 'note') || pick(row, 'comment');
    return [{
      sourceId: `collection:${listName}:${index}`,
      title: pick(row, 'title'),
      mapsUrl: url,
      ...(note ? { note } : {}),
      sourceList: listName,
    }];
  });
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run src/parse/saved-collections.test.ts`
Expected: PASS

- [ ] **Step 7: Write the starred-places fixture**

`fixtures/starred-places/Starred places.json`:
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [2.1769, 41.3825] },
      "properties": {
        "google_maps_url": "https://www.google.com/maps/place/?q=place_id:ChIJsatans",
        "location": {
          "name": "Satan's Coffee Corner",
          "address": "Carrer de l'Arc de Sant Ramon del Call, 11, Barcelona",
          "country_code": "ES"
        }
      }
    },
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [-9.1393, 38.7223] },
      "properties": {
        "name": "Time Out Market",
        "address": "Av. 24 de Julho 49, Lisboa"
      }
    }
  ]
}
```

- [ ] **Step 8: Write the failing GeoJSON parser test**

`src/parse/starred-places.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStarredPlacesGeoJson } from './starred-places.js';

const json = readFileSync('fixtures/starred-places/Starred places.json', 'utf8');

describe('parseStarredPlacesGeoJson', () => {
  it('reads GeoJSON coordinates as [longitude, latitude]', () => {
    const [first] = parseStarredPlacesGeoJson(json);
    expect(first!.lng).toBe(2.1769);
    expect(first!.lat).toBe(41.3825);
  });

  it('reads name and address from the nested location object', () => {
    const [first] = parseStarredPlacesGeoJson(json);
    expect(first!.title).toBe("Satan's Coffee Corner");
    expect(first!.address).toContain('Sant Ramon del Call');
  });

  it('falls back to flat name and address properties', () => {
    const items = parseStarredPlacesGeoJson(json);
    expect(items[1]!.title).toBe('Time Out Market');
    expect(items[1]!.address).toContain('24 de Julho');
  });

  it('labels every item with the Starred places source list', () => {
    for (const item of parseStarredPlacesGeoJson(json)) {
      expect(item.sourceList).toBe('Starred places');
    }
  });

  it('skips features with no resolvable name', () => {
    const bare = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
    });
    expect(parseStarredPlacesGeoJson(bare)).toEqual([]);
  });

  it('returns an empty array when features is missing', () => {
    expect(parseStarredPlacesGeoJson('{"type":"FeatureCollection"}')).toEqual([]);
  });
});
```

- [ ] **Step 9: Run the test and confirm it fails**

Run: `npx vitest run src/parse/starred-places.test.ts`
Expected: FAIL — cannot resolve `./starred-places.js`

- [ ] **Step 10: Write `src/parse/starred-places.ts`**

```ts
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
```

- [ ] **Step 11: Run the test and confirm it passes**

Run: `npx vitest run src/parse/starred-places.test.ts`
Expected: PASS

- [ ] **Step 12: Write the failing merge test**

`src/parse/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseExport } from './index.js';

const starred = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ geometry: { coordinates: [2, 41] }, properties: { name: 'Starred One' } }],
});
const csvB = 'title,item_content_url\nB List Place,https://www.google.com/maps/place/B/\n';
const csvA = 'title,item_content_url\nA List Place,https://www.google.com/maps/place/A/\n';

describe('parseExport', () => {
  it('orders starred places first, then collections alphabetically by list', () => {
    const items = parseExport([
      { path: 'Saved/B list.csv', content: csvB },
      { path: 'Saved/A list.csv', content: csvA },
      { path: 'Maps/Starred places.json', content: starred },
    ], 20);
    expect(items.map((i) => i.title)).toEqual(['Starred One', 'A List Place', 'B List Place']);
  });

  it('derives the list name from the file basename', () => {
    const items = parseExport([{ path: 'Saved/A list.csv', content: csvA }], 20);
    expect(items[0]!.sourceList).toBe('A list');
  });

  it('applies the cap after ordering', () => {
    const items = parseExport([
      { path: 'Saved/B list.csv', content: csvB },
      { path: 'Maps/Starred places.json', content: starred },
    ], 1);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Starred One');
  });

  it('ignores files that are neither .csv nor .json', () => {
    // Content that WOULD yield an item if extension routing were removed.
    // A bare 'binary' string parses to [] under the CSV parser anyway, so it
    // could not distinguish "skipped by extension" from "empty by coincidence".
    const csvLike = 'title,item_content_url\nDecoy,https://www.google.com/maps/place/Decoy/\n';
    expect(parseExport([{ path: 'Saved/photo.jpg', content: csvLike }], 20)).toEqual([]);
  });
});
```

- [ ] **Step 13: Run the test and confirm it fails**

Run: `npx vitest run src/parse/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`

- [ ] **Step 14: Write `src/parse/index.ts`**

```ts
import { basename, extname } from 'node:path';
import type { ExportFile, SavedItem } from '../domain/types.js';
import { parseSavedCollectionsCsv } from './saved-collections.js';
import { parseStarredPlacesGeoJson } from './starred-places.js';

/**
 * Merges every file in an unpacked export into one ordered list, then applies
 * the cap. Order is deterministic — starred places first, then collections
 * alphabetically by list name — so "the first 20" means the same thing on
 * every run regardless of how the archive happened to unzip.
 */
export function parseExport(files: ExportFile[], limit: number): SavedItem[] {
  const starred: SavedItem[] = [];
  const collections: { listName: string; items: SavedItem[] }[] = [];

  for (const file of files) {
    const ext = extname(file.path).toLowerCase();
    const listName = basename(file.path, extname(file.path));

    // One malformed file must not cost the user every other list.
    try {
      if (ext === '.json') {
        starred.push(...parseStarredPlacesGeoJson(file.content));
      } else if (ext === '.csv') {
        collections.push({ listName, items: parseSavedCollectionsCsv(file.content, listName) });
      }
    } catch (error) {
      skipped.set(file.path, error instanceof Error ? error.message : String(error));
    }
  }

  collections.sort((a, b) => a.listName.localeCompare(b.listName));

  return [...starred, ...collections.flatMap((c) => c.items)].slice(0, limit);
}
```

Above `parseExport`, the skip registry — same pattern as `unmappedTypeCounts`
in Task 1, so failures are recorded rather than swallowed without changing
`parseExport`'s signature:

```ts
const skipped = new Map<string, string>();

/** Files that threw during parsing, keyed by path, with the parser's message. */
export function skippedFiles(): ReadonlyMap<string, string> {
  return skipped;
}

export function resetSkippedFiles(): void {
  skipped.clear();
}
```

Add these tests to `src/parse/index.test.ts`:

```ts
  it('skips an unparseable file and still parses the rest', () => {
    resetSkippedFiles();
    const items = parseExport([
      { path: 'Maps/Starred places.json', content: '{ not json at all' },
      { path: 'Saved/A list.csv', content: csvA },
    ], 20);
    expect(items.map((i) => i.title)).toEqual(['A List Place']);
  });

  it('records the skipped file rather than swallowing the error', () => {
    resetSkippedFiles();
    parseExport([{ path: 'Maps/Starred places.json', content: '{ not json at all' }], 20);
    expect([...skippedFiles().keys()]).toEqual(['Maps/Starred places.json']);
    expect(skippedFiles().get('Maps/Starred places.json')).toBeTruthy();
  });
```

- [ ] **Step 15: Run the full suite and confirm it passes**

Run: `npx vitest run`
Expected: PASS, all three parse suites plus earlier tasks

- [ ] **Step 16: Commit**

```bash
git add fixtures/ src/parse/ package.json package-lock.json
git commit -m "feat: parse saved collections CSV and starred places GeoJSON"
```

---

## Task 5: Places API client and enrichment

**Files:**
- Create: `src/enrich/places-client.ts`, `src/enrich/index.ts`
- Test: `src/enrich/places-client.test.ts`, `src/enrich/index.test.ts`

**Interfaces:**
- Consumes: `SavedItem`, `ResolvedPlace` from `src/domain/types.js`; `extractCity`, `extractCountry`, `AddressComponent` from `./address.js`; `categorize` from `../categorize/taxonomy.js`
- Produces: `PlaceSearchResult` interface; `searchText(query: SearchQuery, deps: PlacesDeps): Promise<PlaceSearchResult | null>` where `SearchQuery = { text: string; lat?: number; lng?: number }` and `PlacesDeps = { apiKey: string; fetch?: typeof globalThis.fetch; maxRetries?: number; sleep?: (ms: number) => Promise<void> }`; `enrich(items: SavedItem[], deps: PlacesDeps): Promise<ResolvedPlace[]>`

- [ ] **Step 1: Write the failing client test**

`src/enrich/places-client.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { searchText } from './places-client.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const onePlace = {
  places: [{
    id: 'ChIJabc',
    displayName: { text: "Satan's Coffee Corner" },
    formattedAddress: 'Carrer de l\'Arc, Barcelona',
    primaryType: 'cafe',
    location: { latitude: 41.3825, longitude: 2.1769 },
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
};

const noSleep = async () => {};

describe('searchText', () => {
  it('posts to places:searchText with the API key and field mask', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    await searchText({ text: 'Satans Coffee' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('KEY');
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask'])
      .toBe('places.id,places.displayName,places.formattedAddress,places.primaryType,places.types,places.location,places.addressComponents');
  });

  it('includes a 500m locationBias circle when coordinates are given', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    await searchText({ text: 'x', lat: 41.3825, lng: 2.1769 },
      { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });

    const body = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(body.locationBias.circle).toEqual({
      center: { latitude: 41.3825, longitude: 2.1769 }, radius: 500,
    });
  });

  it('omits locationBias when coordinates are absent', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    await searchText({ text: 'x' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).locationBias).toBeUndefined();
  });

  it('returns the first place', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(onePlace));
    const result = await searchText({ text: 'x' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(result!.id).toBe('ChIJabc');
  });

  it('returns null when there are no matches', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({}));
    const result = await searchText({ text: 'x' }, { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(result).toBeNull();
  });

  it('retries on 429 and succeeds', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(ok(onePlace));
    const result = await searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result!.id).toBe('ChIJabc');
  });

  it('returns null after exhausting retries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, maxRetries: 2, sleep: noSleep });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toBeNull();
  });

  it('does not retry a 403 — that is a billing or key problem', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(searchText({ text: 'x' },
      { apiKey: 'KEY', fetch: fetch as never, sleep: noSleep })).rejects.toThrow(/403/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/enrich/places-client.test.ts`
Expected: FAIL — cannot resolve `./places-client.js`

- [ ] **Step 3: Write `src/enrich/places-client.ts`**

```ts
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
 * normal outcome, not an error. A 403 throws instead, because that is a missing
 * billing account or a bad key and every subsequent call would fail the same way.
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

    if (response.status === 403 || response.status === 401) {
      throw new Error(
        `Places API rejected the request with ${response.status}. ` +
        `Check that the API key is valid and billing is enabled on the project.`,
      );
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxRetries) return null;

    await sleep(2 ** attempt * 250);
  }

  return null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/enrich/places-client.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing enrichment test**

`src/enrich/index.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { enrich } from './index.js';
import type { SavedItem } from '../domain/types.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const cafe = (id: string) => ({
  places: [{
    id,
    displayName: { text: 'Resolved Name' },
    formattedAddress: 'Some Street, Barcelona',
    primaryType: 'cafe',
    location: { latitude: 41.38, longitude: 2.17 },
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
});

const item = (over: Partial<SavedItem>): SavedItem =>
  ({ sourceId: 's1', title: 'Cafe', sourceList: 'Want to go', ...over });

const noSleep = async () => {};

describe('enrich', () => {
  it('resolves placeId, city, country, and category', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJ1')));
    const [place] = await enrich([item({})], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(place).toMatchObject({
      placeId: 'ChIJ1', city: 'Barcelona', country: 'Spain',
      countryCode: 'ES', category: 'Food & Drink', primaryType: 'cafe', resolved: true,
    });
  });

  it('combines title and address into the search text', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJ1')));
    await enrich([item({ title: 'Cafe', address: 'Main St' })],
      { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).textQuery).toBe('Cafe Main St');
  });

  it('keeps unresolved items with category Unknown', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({}));
    const [place] = await enrich([item({ title: 'Ghost Bar', note: 'keep me' })],
      { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(place).toMatchObject({
      placeId: null, name: 'Ghost Bar', category: 'Unknown',
      city: null, resolved: false, note: 'keep me',
    });
  });

  it('deduplicates by placeId and merges sourceLists', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJsame')));
    const places = await enrich([
      item({ sourceId: 'a', sourceList: 'Starred places' }),
      item({ sourceId: 'b', sourceList: 'Want to go' }),
    ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(places).toHaveLength(1);
    expect(places[0]!.sourceLists).toEqual(['Starred places', 'Want to go']);
  });

  it('never deduplicates unresolved items together', async () => {
    // mockImplementation, not mockResolvedValue: this test makes two real
    // fetch calls (the titles differ, so the cache does not collapse them),
    // and a single Response body cannot be read twice.
    const fetch = vi.fn().mockImplementation(async () => ok({}));
    const places = await enrich([
      item({ sourceId: 'a', title: 'One' }), item({ sourceId: 'b', title: 'Two' }),
    ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
    expect(places).toHaveLength(2);
  });

  it('caches by query so a repeated search is fetched once', async () => {
    const fetch = vi.fn().mockResolvedValue(ok(cafe('ChIJ1')));
    await enrich([
      item({ sourceId: 'a', title: 'Same Place' }),
      item({ sourceId: 'b', title: 'Same Place' }),
    ], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npx vitest run src/enrich/index.test.ts`
Expected: FAIL — `enrich` is not exported

- [ ] **Step 7: Write `src/enrich/index.ts`**

```ts
import type { ResolvedPlace, SavedItem } from '../domain/types.js';
import { categorize } from '../categorize/taxonomy.js';
import { extractCity, extractCountry } from './address.js';
import { searchText, type PlacesDeps, type PlaceSearchResult } from './places-client.js';

function searchTextFor(item: SavedItem): string {
  return item.address ? `${item.title} ${item.address}` : item.title;
}

/**
 * Keeps both annotations when the same place carries a different note in two
 * lists. These are the user's own words — dropping one silently is data loss.
 */
function mergeNotes(existing: string | null, incoming: string | null): string | null {
  if (!existing) return incoming;
  if (!incoming || existing === incoming) return existing;
  return `${existing} — ${incoming}`;
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
      existing.note = mergeNotes(existing.note, place.note);
    } else {
      byPlaceId.set(place.placeId, place);
    }
  }

  return [...byPlaceId.values(), ...unresolved];
}
```

- [ ] **Step 8: Run the full suite and confirm it passes**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/enrich/
git commit -m "feat: resolve saved items to places via Places API with dedupe and cache"
```

---

## Task 6: Database layer

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`
- Test: `src/db/client.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: Drizzle tables `users`, `oauthTokens`, `extractions`, `rawArtifacts`, `places`; `createDb(url: string): Db` where `Db = BetterSQLite3Database<typeof schema>`; `migrate(db: Db): void`

- [ ] **Step 1: Install dependencies**

```bash
npm install drizzle-orm better-sqlite3
npm install -D @types/better-sqlite3
```

drizzle-kit is deliberately not installed. Phase 1 has one schema version and
no deployed database to migrate forward from, so `migrate()` below is idempotent
DDL rather than generated migration files.

- [ ] **Step 2: Write `src/db/schema.ts`**

```ts
import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const oauthTokens = sqliteTable('oauth_tokens', {
  userId: text('user_id').primaryKey().references(() => users.id),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at').notNull(),
  scopes: text('scopes').notNull(),
});

export const extractions = sqliteTable('extractions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  /** pending | running | complete | failed | timed_out */
  status: text('status').notNull(),
  archiveJobId: text('archive_job_id'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const rawArtifacts = sqliteTable('raw_artifacts', {
  id: text('id').primaryKey(),
  extractionId: text('extraction_id').notNull().references(() => extractions.id),
  path: text('path').notNull(),
  content: blob('content', { mode: 'buffer' }).notNull(),
});

export const places = sqliteTable('places', {
  id: text('id').primaryKey(),
  extractionId: text('extraction_id').notNull().references(() => extractions.id),
  /** The full ResolvedPlace, serialized. Phase 1 has no query-by-column need. */
  payload: text('payload', { mode: 'json' }).notNull(),
});
```

- [ ] **Step 3: Write the failing client test**

`src/db/client.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createDb, migrate } from './client.js';
import { users, extractions } from './schema.js';
import { eq } from 'drizzle-orm';

describe('createDb', () => {
  it('creates every table on migrate and round-trips a row', () => {
    const db = createDb(':memory:');
    migrate(db);

    db.insert(users).values({
      id: 'u1', googleSub: 'sub-1', email: 'a@b.com', createdAt: 1,
    }).run();

    db.insert(extractions).values({
      id: 'e1', userId: 'u1', status: 'pending', createdAt: 1, updatedAt: 1,
    }).run();

    const found = db.select().from(extractions).where(eq(extractions.id, 'e1')).all();
    expect(found).toHaveLength(1);
    expect(found[0]!.status).toBe('pending');
    expect(found[0]!.archiveJobId).toBeNull();
  });

  it('is idempotent — migrating twice does not throw', () => {
    const db = createDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `npx vitest run src/db/client.test.ts`
Expected: FAIL — cannot resolve `./client.js`

- [ ] **Step 5: Write `src/db/client.ts`**

```ts
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export function createDb(url: string): Db {
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/**
 * Creates the schema. Written as idempotent DDL rather than drizzle-kit
 * migration files because Phase 1 has a single schema version and no
 * deployed database to migrate forward from.
 */
export function migrate(db: Db): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
       user_id TEXT PRIMARY KEY REFERENCES users(id),
       access_token TEXT NOT NULL,
       refresh_token TEXT,
       expires_at INTEGER NOT NULL,
       scopes TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS extractions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id),
       status TEXT NOT NULL,
       archive_job_id TEXT,
       error TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS raw_artifacts (
       id TEXT PRIMARY KEY,
       extraction_id TEXT NOT NULL REFERENCES extractions(id),
       path TEXT NOT NULL,
       content BLOB NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS places (
       id TEXT PRIMARY KEY,
       extraction_id TEXT NOT NULL REFERENCES extractions(id),
       payload TEXT NOT NULL
     )`,
  ];

  // db.run() accepts a raw SQL string and is what drizzle's own migrators use.
  // Do NOT reach for db.$client — it exists only on the intersection type
  // drizzle() returns, so using it would force widening the exported Db type
  // and leak the raw driver handle to every consumer.
  for (const statement of statements) {
    db.run(statement);
  }
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run src/db/client.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/ package.json package-lock.json
git commit -m "feat: add SQLite schema and connection layer"
```

---

## Task 7: Data Portability client

**Files:**
- Create: `src/portability/client.ts`
- Test: `src/portability/client.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PORTABILITY_RESOURCES` constant; `PORTABILITY_SCOPES` constant; `initiateArchive(accessToken, deps): Promise<{ archiveJobId: string; accessType: string }>`; `getArchiveState(accessToken, jobId, deps): Promise<{ state: ArchiveState; urls: string[] }>`; `resetAuthorization(accessToken, deps): Promise<void>`; `ConsentAlreadyUsedError`; where `deps = { fetch?: typeof globalThis.fetch }` and `ArchiveState = 'IN_PROGRESS' | 'COMPLETE' | 'FAILED' | 'CANCELLED'`

- [ ] **Step 1: Write the failing test**

`src/portability/client.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  initiateArchive, getArchiveState, resetAuthorization,
  PORTABILITY_RESOURCES, PORTABILITY_SCOPES, ConsentAlreadyUsedError,
} from './client.js';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('constants', () => {
  it('requests both saved collections and starred places', () => {
    expect(PORTABILITY_RESOURCES).toEqual(['saved.collections', 'maps.starred_places']);
  });

  it('derives full scope URLs from the resource names', () => {
    expect(PORTABILITY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/dataportability.saved.collections',
      'https://www.googleapis.com/auth/dataportability.maps.starred_places',
    ]);
  });
});

describe('initiateArchive', () => {
  it('posts the resource list with a bearer token', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ archiveJobId: 'job-1', accessType: 'ACCESS_TYPE_ONE_TIME' }));
    const result = await initiateArchive('tok', { fetch: fetch as never });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://dataportability.googleapis.com/v1/portabilityArchive:initiate');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ resources: PORTABILITY_RESOURCES });
    expect(result.archiveJobId).toBe('job-1');
  });

  it('throws ConsentAlreadyUsedError on 403 RESOURCE_EXHAUSTED', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 403 }),
    );
    await expect(initiateArchive('tok', { fetch: fetch as never }))
      .rejects.toBeInstanceOf(ConsentAlreadyUsedError);
  });

  it('throws a plain error on other failures', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(initiateArchive('tok', { fetch: fetch as never })).rejects.toThrow(/500/);
  });
});

describe('getArchiveState', () => {
  it('polls the job state endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ state: 'IN_PROGRESS' }));
    const result = await getArchiveState('tok', 'job-1', { fetch: fetch as never });

    expect(fetch.mock.calls[0]![0])
      .toBe('https://dataportability.googleapis.com/v1/archiveJobs/job-1/portabilityArchiveState');
    expect(result).toEqual({ state: 'IN_PROGRESS', urls: [] });
  });

  it('returns signed URLs when complete', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ state: 'COMPLETE', urls: ['https://a', 'https://b'] }));
    const result = await getArchiveState('tok', 'job-1', { fetch: fetch as never });
    expect(result).toEqual({ state: 'COMPLETE', urls: ['https://a', 'https://b'] });
  });
});

describe('resetAuthorization', () => {
  it('posts to authorization:reset', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    await resetAuthorization('tok', { fetch: fetch as never });
    expect(fetch.mock.calls[0]![0])
      .toBe('https://dataportability.googleapis.com/v1/authorization:reset');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/portability/client.test.ts`
Expected: FAIL — cannot resolve `./client.js`

- [ ] **Step 3: Write `src/portability/client.ts`**

```ts
const BASE = 'https://dataportability.googleapis.com/v1';

/**
 * Resource names for portabilityArchive:initiate. These are the OAuth scope
 * suffixes — the quickstart shows {"resources":["myactivity.search"]}.
 */
export const PORTABILITY_RESOURCES = ['saved.collections', 'maps.starred_places'] as const;

export const PORTABILITY_SCOPES = PORTABILITY_RESOURCES.map(
  (resource) => `https://www.googleapis.com/auth/dataportability.${resource}`,
);

export type ArchiveState = 'IN_PROGRESS' | 'COMPLETE' | 'FAILED' | 'CANCELLED';

export interface PortabilityDeps {
  fetch?: typeof globalThis.fetch;
}

/**
 * Raised on a 403 carrying RESOURCE_EXHAUSTED.
 *
 * That status is ambiguous: Google uses it both for a spent one-time
 * authorization AND for ordinary quota/rate limiting. The remedies conflict —
 * authorization:reset invalidates the current token, so "just reset it" is
 * destructive when the real cause was a rate limit. The message therefore
 * states both possibilities instead of asserting the likelier one.
 */
export class ConsentAlreadyUsedError extends Error {
  constructor() {
    super(
      'Google returned RESOURCE_EXHAUSTED. This usually means the one-time ' +
      'Portability authorization has already been spent, but Google returns the ' +
      'same status for quota and rate limiting. If you have not just run an ' +
      'extraction, wait and retry before resetting — POST /auth/reset invalidates ' +
      'the current token, which is destructive if it was still valid. If the ' +
      'authorization really is spent: POST /auth/reset, then re-authorize at ' +
      'GET /auth/google.',
    );
    this.name = 'ConsentAlreadyUsedError';
  }
}

async function call(
  url: string,
  accessToken: string,
  deps: PortabilityDeps,
  body?: unknown,
): Promise<Response> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  return doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function initiateArchive(
  accessToken: string,
  deps: PortabilityDeps = {},
): Promise<{ archiveJobId: string; accessType: string }> {
  const response = await call(`${BASE}/portabilityArchive:initiate`, accessToken, deps, {
    resources: [...PORTABILITY_RESOURCES],
  });

  if (response.status === 403) {
    const text = await response.text();
    if (text.includes('RESOURCE_EXHAUSTED')) throw new ConsentAlreadyUsedError();
    throw new Error(`Portability initiate failed with 403: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Portability initiate failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as { archiveJobId: string; accessType: string };
}

export async function getArchiveState(
  accessToken: string,
  jobId: string,
  deps: PortabilityDeps = {},
): Promise<{ state: ArchiveState; urls: string[] }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(`${BASE}/archiveJobs/${jobId}/portabilityArchiveState`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Portability state check failed with ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as { state: ArchiveState; urls?: string[] };
  return { state: json.state, urls: json.urls ?? [] };
}

export async function resetAuthorization(
  accessToken: string,
  deps: PortabilityDeps = {},
): Promise<void> {
  const response = await call(`${BASE}/authorization:reset`, accessToken, deps);
  if (!response.ok) {
    throw new Error(`Authorization reset failed with ${response.status}: ${await response.text()}`);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/portability/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/portability/
git commit -m "feat: add Data Portability API client"
```

---

## Task 8: Archive download and unpacking

**Files:**
- Create: `src/archive/download.ts`
- Test: `src/archive/download.test.ts`

**Interfaces:**
- Consumes: `ExportFile` from `src/domain/types.js`
- Produces: `downloadArchive(urls: string[], deps: { fetch?: typeof globalThis.fetch }): Promise<ExportFile[]>`

- [ ] **Step 1: Install the unzip library**

```bash
npm install fflate
```

- [ ] **Step 2: Write the failing test**

`src/archive/download.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { downloadArchive } from './download.js';

// Uint8Array<ArrayBuffer>, not bare Uint8Array: TS 5.9 made Uint8Array generic
// over its buffer type, and DOM's BodyInit requires an ArrayBuffer-backed view.
const bin = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes, { status: 200 });

describe('downloadArchive', () => {
  it('unzips a zip response into its member files', async () => {
    const zip = zipSync({
      'Saved/Want to go.csv': strToU8('title\nA\n'),
      'Maps/Starred places.json': strToU8('{}'),
    });
    const fetch = vi.fn().mockResolvedValue(bin(zip));

    const files = await downloadArchive(['https://signed'], { fetch: fetch as never });

    expect(files.map((f) => f.path).sort())
      .toEqual(['Maps/Starred places.json', 'Saved/Want to go.csv']);
    expect(files.find((f) => f.path.endsWith('.csv'))!.content).toBe('title\nA\n');
  });

  it('treats a non-zip response as a single file named from the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(bin(strToU8('title\nA\n')));
    const files = await downloadArchive(
      ['https://storage.googleapis.com/bucket/Want%20to%20go.csv?sig=x'],
      { fetch: fetch as never },
    );
    expect(files).toEqual([{ path: 'Want to go.csv', content: 'title\nA\n' }]);
  });

  it('concatenates results across multiple signed URLs', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(bin(strToU8('a')))
      .mockResolvedValueOnce(bin(strToU8('b')));
    const files = await downloadArchive(
      ['https://host/one.csv', 'https://host/two.csv'],
      { fetch: fetch as never },
    );
    expect(files).toHaveLength(2);
  });

  it('skips zip directory entries', async () => {
    const zip = zipSync({ 'Saved/': strToU8(''), 'Saved/x.csv': strToU8('title\n') });
    const fetch = vi.fn().mockResolvedValue(bin(zip));
    const files = await downloadArchive(['https://signed'], { fetch: fetch as never });
    expect(files.map((f) => f.path)).toEqual(['Saved/x.csv']);
  });

  it('throws when a signed URL fails', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
    await expect(downloadArchive(['https://signed'], { fetch: fetch as never }))
      .rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/archive/download.test.ts`
Expected: FAIL — cannot resolve `./download.js`

- [ ] **Step 4: Write `src/archive/download.ts`**

```ts
import { unzipSync, strFromU8 } from 'fflate';
import { basename } from 'node:path';
import type { ExportFile } from '../domain/types.js';

/** Local file header magic for a PKZIP archive. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function nameFromUrl(url: string): string {
  try {
    return decodeURIComponent(basename(new URL(url).pathname)) || 'export';
  } catch {
    return 'export';
  }
}

/**
 * Fetches every signed URL and returns the unpacked text files.
 *
 * Google may hand back either a zip or individual objects depending on the
 * export, so both are handled by sniffing the PKZIP magic bytes rather than
 * trusting the URL or content type.
 */
export async function downloadArchive(
  urls: string[],
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<ExportFile[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const files: ExportFile[] = [];

  for (const url of urls) {
    const response = await doFetch(url);
    if (!response.ok) {
      throw new Error(`Archive download failed with ${response.status} for ${url}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (isZip(bytes)) {
      const entries = unzipSync(bytes);
      for (const [path, content] of Object.entries(entries)) {
        if (path.endsWith('/')) continue;
        files.push({ path, content: strFromU8(content) });
      }
    } else {
      files.push({ path: nameFromUrl(url), content: strFromU8(bytes) });
    }
  }

  return files;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/archive/download.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/archive/ package.json package-lock.json
git commit -m "feat: download and unpack portability archives"
```

---

## Task 9: Configuration and OAuth

**Files:**
- Create: `src/config.ts`, `src/context.ts`, `src/auth/oauth.ts`, `src/auth/routes.ts`
- Test: `src/config.test.ts`, `src/auth/oauth.test.ts`

**Interfaces:**
- Consumes: `PORTABILITY_SCOPES`, `resetAuthorization` from `src/portability/client.js`; `Db`, tables from `src/db/`
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`; `Config` type; `AppContext = { db: Db; config: Config }` from `src/context.js`; `buildAuthUrl(config): string`; `exchangeCode(code, config, deps): Promise<TokenSet>`; `persistTokens(db, tokens): string`; `getValidAccessToken(db, userId, config, deps): Promise<string>`; `ReauthRequiredError`; `authRoutes(app, ctx)` Fastify plugin

- [ ] **Step 1: Install dependencies**

```bash
npm install fastify zod dotenv
```

> **Amendment — OAuth CSRF `state`.** The original plan omitted `state`, leaving
> the callback willing to exchange any authorization code from any source
> (RFC 9700 violation, authorization-code injection). Added:
>
> - `oauth_states` table — `state TEXT PRIMARY KEY`, `created_at INTEGER NOT NULL`
>   — declared in **both** `src/db/schema.ts` and `migrate()`'s raw DDL, with a
>   round-trip parity test like the other five tables.
> - `createAuthState(db): string` minting `randomBytes(32).toString('base64url')`
>   from `node:crypto`.
> - `consumeAuthState(db, state): boolean` — single-use (the row is deleted on
>   read **regardless of validity**, so a captured value cannot be replayed) and
>   enforcing a 10-minute TTL.
> - `buildAuthUrl(config, state)` — note the added parameter.
> - Callback order: `error` → `state` → `code` → exchange. Each guard `return`s,
>   so `exchangeCode` is unreachable on an unverified callback.

- [ ] **Step 2: Write the failing config test**

`src/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_PLACES_API_KEY: 'places-key',
  DATABASE_URL: './tidymap.db',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);
    expect(config.google.clientId).toBe('id');
    expect(config.placesApiKey).toBe('places-key');
    expect(config.port).toBe(3000);
    expect(config.portabilitySource).toBe('live');
  });

  it('defaults extraction limit to 20', () => {
    expect(loadConfig(valid).extractionLimit).toBe(20);
  });

  it('accepts fixture as a portability source', () => {
    expect(loadConfig({ ...valid, PORTABILITY_SOURCE: 'fixture' }).portabilitySource).toBe('fixture');
  });

  it('rejects an unknown portability source', () => {
    expect(() => loadConfig({ ...valid, PORTABILITY_SOURCE: 'maybe' })).toThrow();
  });

  it('fails fast with a readable message when the Places key is missing', () => {
    const { GOOGLE_PLACES_API_KEY: _omitted, ...withoutKey } = valid;
    expect(() => loadConfig(withoutKey)).toThrow(/GOOGLE_PLACES_API_KEY/);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`

- [ ] **Step 4: Write `src/config.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_PLACES_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  PORTABILITY_SOURCE: z.enum(['live', 'fixture']).default('live'),
  PORT: z.coerce.number().default(3000),
  EXTRACTION_LIMIT: z.coerce.number().default(20),
});

export interface Config {
  google: { clientId: string; clientSecret: string; redirectUri: string };
  placesApiKey: string;
  databaseUrl: string;
  portabilitySource: 'live' | 'fixture';
  port: number;
  extractionLimit: number;
}

/**
 * Parses and validates the environment. Throws on the first problem with the
 * offending variable named, so a missing Places key surfaces at boot rather
 * than as twenty confusing 403s mid-extraction.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }

  const e = parsed.data;
  return {
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: e.GOOGLE_REDIRECT_URI,
    },
    placesApiKey: e.GOOGLE_PLACES_API_KEY,
    databaseUrl: e.DATABASE_URL,
    portabilitySource: e.PORTABILITY_SOURCE,
    port: e.PORT,
    extractionLimit: e.EXTRACTION_LIMIT,
  };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5b: Write `src/context.ts`**

The shared handle every route and the pipeline receive. It lives in its own
module so `jobs/` does not have to import from `auth/` just to name a type.

```ts
import type { Config } from './config.js';
import type { Db } from './db/client.js';

export interface AppContext {
  db: Db;
  config: Config;
}
```

- [ ] **Step 6: Write the failing OAuth test**

`src/auth/oauth.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildAuthUrl, getValidAccessToken } from './oauth.js';
import { createDb, migrate } from '../db/client.js';
import { users, oauthTokens } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';

const config = loadConfig({
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
});

function seedDb(expiresAt: number, refreshToken: string | null) {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', googleSub: 's', email: 'a@b.com', createdAt: 0 }).run();
  db.insert(oauthTokens).values({
    userId: 'u1', accessToken: 'old-token', refreshToken, expiresAt, scopes: '',
  }).run();
  return db;
}

describe('buildAuthUrl', () => {
  it('requests both portability scopes plus openid and email', () => {
    const url = new URL(buildAuthUrl(config));
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/dataportability.saved.collections');
    expect(scopes).toContain('https://www.googleapis.com/auth/dataportability.maps.starred_places');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
  });

  it('requests offline access and forces the consent prompt', () => {
    const url = new URL(buildAuthUrl(config));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('getValidAccessToken', () => {
  it('returns the stored token when it has not expired', async () => {
    const db = seedDb(Date.now() + 600_000, 'refresh');
    const fetch = vi.fn();
    const token = await getValidAccessToken(db, 'u1', config, { fetch: fetch as never });
    expect(token).toBe('old-token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the new one', async () => {
    const db = seedDb(Date.now() - 1000, 'refresh');
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'new-token', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const token = await getValidAccessToken(db, 'u1', config, { fetch: fetch as never });

    expect(token).toBe('new-token');
    const stored = db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'u1')).all();
    expect(stored[0]!.accessToken).toBe('new-token');
  });

  it('throws a re-auth error when the token is expired and no refresh token exists', async () => {
    const db = seedDb(Date.now() - 1000, null);
    await expect(getValidAccessToken(db, 'u1', config, { fetch: vi.fn() as never }))
      .rejects.toThrow(/GET \/auth\/google/);
  });

  it('throws a re-auth error when the refresh is rejected', async () => {
    const db = seedDb(Date.now() - 1000, 'refresh');
    const fetch = vi.fn().mockResolvedValue(new Response('invalid_grant', { status: 400 }));
    await expect(getValidAccessToken(db, 'u1', config, { fetch: fetch as never }))
      .rejects.toThrow(/GET \/auth\/google/);
  });
});
```

- [ ] **Step 7: Run the test and confirm it fails**

Run: `npx vitest run src/auth/oauth.test.ts`
Expected: FAIL — cannot resolve `./oauth.js`

- [ ] **Step 8: Write `src/auth/oauth.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { oauthTokens, users } from '../db/schema.js';
import { PORTABILITY_SCOPES } from '../portability/client.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SCOPES = ['openid', 'email', ...PORTABILITY_SCOPES];

export interface OAuthDeps {
  fetch?: typeof globalThis.fetch;
}

export class ReauthRequiredError extends Error {
  constructor(reason: string) {
    super(`${reason} Re-authorize at GET /auth/google.`);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * Builds the consent URL. `access_type=offline` with `prompt=consent` is
 * required rather than optional here: Google only returns a refresh token on
 * a fresh consent, and Portability's one-time authorization means we come
 * back through consent regularly.
 */
export function buildAuthUrl(config: Config): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string;
  googleSub: string;
  email: string;
}

function decodeIdToken(idToken: string): { sub: string; email: string } {
  const payload = idToken.split('.')[1] ?? '';
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(json) as { sub: string; email: string };
}

export async function exchangeCode(
  code: string,
  config: Config,
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const response = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed with ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    access_token: string; refresh_token?: string; expires_in: number;
    scope: string; id_token: string;
  };

  const identity = decodeIdToken(json.id_token);

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
    scopes: json.scope,
    googleSub: identity.sub,
    email: identity.email,
  };
}

export function persistTokens(db: Db, tokens: TokenSet): string {
  const existing = db.select().from(users).where(eq(users.googleSub, tokens.googleSub)).all();
  const userId = existing[0]?.id ?? `user_${tokens.googleSub}`;

  if (!existing[0]) {
    db.insert(users).values({
      id: userId, googleSub: tokens.googleSub, email: tokens.email, createdAt: Date.now(),
    }).run();
  }

  db.insert(oauthTokens).values({
    userId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
  }).onConflictDoUpdate({
    target: oauthTokens.userId,
    set: {
      accessToken: tokens.accessToken,
      // Only overwrite the refresh token when Google actually sent one.
      // Google omits refresh_token on most responses, and clobbering a good
      // stored value with null would force a fresh consent on every later
      // extraction — the precise cost the one-time authorization makes expensive.
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    },
  }).run();

  return userId;
}

/** 60s of slack so a token does not expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export async function getValidAccessToken(
  db: Db,
  userId: string,
  config: Config,
  deps: OAuthDeps = {},
): Promise<string> {
  const rows = db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)).all();
  const row = rows[0];
  if (!row) throw new ReauthRequiredError('No tokens stored for this user.');

  if (row.expiresAt - EXPIRY_SKEW_MS > Date.now()) return row.accessToken;
  if (!row.refreshToken) throw new ReauthRequiredError('Access token expired and no refresh token is stored.');

  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new ReauthRequiredError('Refresh token was rejected by Google.');
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  const expiresAt = Date.now() + json.expires_in * 1000;

  db.update(oauthTokens)
    .set({ accessToken: json.access_token, expiresAt })
    .where(eq(oauthTokens.userId, userId))
    .run();

  return json.access_token;
}
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `npx vitest run src/auth/oauth.test.ts`
Expected: PASS

- [ ] **Step 10: Write `src/auth/routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { buildAuthUrl, exchangeCode, persistTokens, getValidAccessToken } from './oauth.js';
import { resetAuthorization } from '../portability/client.js';

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/auth/google', async (_request, reply) => {
    return reply.redirect(buildAuthUrl(ctx.config), 302);
  });

  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      const { code, error } = request.query;

      if (error) return reply.code(400).send({ error: `Consent was denied: ${error}` });
      if (!code) return reply.code(400).send({ error: 'Missing authorization code.' });

      const tokens = await exchangeCode(code, ctx.config);
      const userId = persistTokens(ctx.db, tokens);

      return reply.send({
        userId,
        email: tokens.email,
        next: `POST /extractions with { "userId": "${userId}" }`,
      });
    },
  );

  app.post<{ Body: { userId: string } }>('/auth/reset', async (request, reply) => {
    const accessToken = await getValidAccessToken(ctx.db, request.body.userId, ctx.config);
    await resetAuthorization(accessToken);

    return reply.send({
      reset: true,
      // The reset invalidates the tokens we just used, so consent must be repeated.
      next: 'GET /auth/google to re-authorize before the next extraction.',
    });
  });
}
```

- [ ] **Step 11: Run the full suite and confirm it passes**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/config.ts src/config.test.ts src/auth/ package.json package-lock.json
git commit -m "feat: add config validation and Google OAuth flow"
```

---

## Task 10: Pipeline orchestration and fixture mode

**Files:**
- Create: `src/jobs/pipeline.ts`, `src/jobs/fixture-source.ts`
- Test: `src/jobs/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–9
- Produces: `runExtraction(extractionId, userId, ctx, deps): Promise<void>`; `PipelineDeps = { fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void>; pollTimeoutMs?: number; now?: () => number }`; `loadFixtureExport(): ExportFile[]`

- [ ] **Step 1: Write `src/jobs/fixture-source.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportFile } from '../domain/types.js';

const FIXTURE_DIRS = ['fixtures/starred-places', 'fixtures/saved-collections'];

/**
 * Reads the committed sample export instead of calling Google.
 *
 * This exists because Portability authorization is one-time-use: every real
 * run costs a browser consent round-trip, which makes iterating on parsing
 * or grouping logic against live data impractical.
 */
export function loadFixtureExport(): ExportFile[] {
  return FIXTURE_DIRS.flatMap((dir) =>
    readdirSync(dir).map((name) => ({
      path: join(dir, name),
      content: readFileSync(join(dir, name), 'utf8'),
    })),
  );
}
```

- [ ] **Step 2: Write the failing pipeline test**

`src/jobs/pipeline.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runExtraction } from './pipeline.js';
import { createDb, migrate } from '../db/client.js';
import { users, extractions, places } from '../db/schema.js';
import { loadConfig } from '../config.js';

function ctxWith(source: 'live' | 'fixture') {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', googleSub: 's', email: 'a@b.com', createdAt: 0 }).run();
  db.insert(extractions).values({
    id: 'e1', userId: 'u1', status: 'pending', createdAt: 0, updatedAt: 0,
  }).run();

  const config = loadConfig({
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
    PORTABILITY_SOURCE: source,
  });
  return { db, config };
}

// A factory, not a shared instance: the pipeline makes several Places calls and
// a Response body can only be read once. `.mockResolvedValue(shared.clone())`
// clones exactly once and then reuses the same object.
const placesOk = () => new Response(JSON.stringify({
  places: [{
    id: 'ChIJfixture',
    displayName: { text: 'Fixture Cafe' },
    primaryType: 'cafe',
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

const noSleep = async () => {};

describe('runExtraction in fixture mode', () => {
  it('completes without calling the Portability API and stores places', async () => {
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockImplementation(async () => placesOk());

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('complete');

    const stored = ctx.db.select().from(places).where(eq(places.extractionId, 'e1')).all();
    expect(stored.length).toBeGreaterThan(0);

    for (const call of fetch.mock.calls) {
      expect(call[0]).not.toContain('dataportability.googleapis.com');
    }
  });

  it('marks the extraction failed and records the reason when Places throws', async () => {
    const ctx = ctxWith('fixture');
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));

    await runExtraction('e1', 'u1', ctx, { fetch: fetch as never, sleep: noSleep });

    const row = ctx.db.select().from(extractions).where(eq(extractions.id, 'e1')).all()[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/403/);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/jobs/pipeline.test.ts`
Expected: FAIL — cannot resolve `./pipeline.js`

- [ ] **Step 4: Write `src/jobs/pipeline.ts`**

```ts
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { ExportFile } from '../domain/types.js';
import { getValidAccessToken } from '../auth/oauth.js';
import { downloadArchive } from '../archive/download.js';
import { enrich } from '../enrich/index.js';
import { parseExport } from '../parse/index.js';
import { getArchiveState, initiateArchive } from '../portability/client.js';
import { extractions, places, rawArtifacts } from '../db/schema.js';
import { loadFixtureExport } from './fixture-source.js';

export interface PipelineDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutMs?: number;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_CAP_MS = 30_000;

function setStatus(ctx: AppContext, id: string, status: string, extra: Record<string, unknown> = {}) {
  ctx.db.update(extractions)
    .set({ status, updatedAt: Date.now(), ...extra })
    .where(eq(extractions.id, id))
    .run();
}

/**
 * Polls until the archive is ready. On timeout the job is marked `timed_out`
 * but the archiveJobId is kept, so polling can resume later — re-initiating
 * would burn the one-time consent for nothing.
 */
async function waitForArchive(
  accessToken: string,
  jobId: string,
  deps: PipelineDeps,
): Promise<string[] | 'timed_out'> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.pollTimeoutMs ?? POLL_TIMEOUT_MS);

  let attempt = 0;
  while (now() < deadline) {
    const state = await getArchiveState(accessToken, jobId, { ...(deps.fetch ? { fetch: deps.fetch } : {}) });

    if (state.state === 'COMPLETE') return state.urls;
    if (state.state === 'FAILED' || state.state === 'CANCELLED') {
      throw new Error(`Google reported the archive job as ${state.state}.`);
    }

    await sleep(Math.min(2 ** attempt * 2000, POLL_CAP_MS));
    attempt++;
  }

  return 'timed_out';
}

async function fetchExportFiles(
  ctx: AppContext,
  extractionId: string,
  userId: string,
  deps: PipelineDeps,
): Promise<ExportFile[] | 'timed_out'> {
  if (ctx.config.portabilitySource === 'fixture') return loadFixtureExport();

  const accessToken = await getValidAccessToken(ctx.db, userId, ctx.config, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const { archiveJobId } = await initiateArchive(accessToken, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  ctx.db.update(extractions)
    .set({ archiveJobId, updatedAt: Date.now() })
    .where(eq(extractions.id, extractionId))
    .run();

  const urls = await waitForArchive(accessToken, archiveJobId, deps);
  if (urls === 'timed_out') return 'timed_out';

  return downloadArchive(urls, { ...(deps.fetch ? { fetch: deps.fetch } : {}) });
}

/**
 * Runs the full pipeline for one extraction and records the outcome.
 *
 * Never throws — every failure path is written to the extraction row so the
 * status endpoint can report it. The 20-item cap is applied inside
 * parseExport, before enrichment, so a failure later never costs Places calls
 * for items beyond the cap.
 */
export async function runExtraction(
  extractionId: string,
  userId: string,
  ctx: AppContext,
  deps: PipelineDeps = {},
): Promise<void> {
  try {
    setStatus(ctx, extractionId, 'running');

    const files = await fetchExportFiles(ctx, extractionId, userId, deps);
    if (files === 'timed_out') {
      setStatus(ctx, extractionId, 'timed_out', {
        error: 'Archive was not ready within 15 minutes. Poll GET /extractions/:id again later.',
      });
      return;
    }

    for (const file of files) {
      ctx.db.insert(rawArtifacts).values({
        id: randomUUID(),
        extractionId,
        path: file.path,
        content: Buffer.from(file.content, 'utf8'),
      }).run();
    }

    const items = parseExport(files, ctx.config.extractionLimit);

    const resolved = await enrich(items, {
      apiKey: ctx.config.placesApiKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });

    for (const place of resolved) {
      ctx.db.insert(places).values({
        id: randomUUID(),
        extractionId,
        payload: place,
      }).run();
    }

    setStatus(ctx, extractionId, 'complete', { error: null });
  } catch (error) {
    setStatus(ctx, extractionId, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/jobs/pipeline.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/jobs/
git commit -m "feat: orchestrate the extraction pipeline with fixture mode"
```

---

## Task 11: HTTP endpoints and server assembly

**Files:**
- Create: `src/jobs/routes.ts`, `src/server.ts`
- Test: `src/jobs/routes.test.ts`

**Interfaces:**
- Consumes: `runExtraction` from `./pipeline.js`; `AppContext` from `../auth/routes.js`; `group` from `../group/index.js`
- Produces: `jobRoutes(app, ctx, deps)` Fastify plugin; `buildServer(ctx, deps): FastifyInstance`

- [ ] **Step 1: Write the failing routes test**

`src/jobs/routes.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildServer } from '../server.js';
import { createDb, migrate } from '../db/client.js';
import { users, extractions } from '../db/schema.js';
import { loadConfig } from '../config.js';
import type { GroupedResult, ResolvedPlace } from '../domain/types.js';

const placesOk = () => new Response(JSON.stringify({
  places: [{
    id: 'ChIJfixture',
    displayName: { text: 'Fixture Cafe' },
    primaryType: 'cafe',
    addressComponents: [
      { longText: 'Barcelona', shortText: 'Barcelona', types: ['locality'] },
      { longText: 'Spain', shortText: 'ES', types: ['country'] },
    ],
  }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

function buildTestServer() {
  const db = createDb(':memory:');
  migrate(db);
  db.insert(users).values({ id: 'u1', googleSub: 's', email: 'a@b.com', createdAt: 0 }).run();

  const config = loadConfig({
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_PLACES_API_KEY: 'k', DATABASE_URL: ':memory:',
    PORTABILITY_SOURCE: 'fixture',
  });

  // awaitPipeline makes the request/response cycle deterministic in tests.
  const app = buildServer({ db, config }, {
    awaitPipeline: true,
    fetch: vi.fn().mockImplementation(async () => placesOk()) as never,
    sleep: async () => {},
  });

  return { app, db };
}

async function startExtraction(app: ReturnType<typeof buildTestServer>['app']) {
  const created = await app.inject({
    method: 'POST', url: '/extractions', payload: { userId: 'u1' },
  });
  return created;
}

describe('extraction endpoints', () => {
  it('creates an extraction and reports completion, then returns grouped results', async () => {
    const { app } = buildTestServer();

    const created = await startExtraction(app);
    expect(created.statusCode).toBe(202);
    const { jobId } = created.json<{ jobId: string }>();
    expect(jobId).toBeTruthy();

    const status = await app.inject({ method: 'GET', url: `/extractions/${jobId}` });
    expect(status.json<{ status: string }>().status).toBe('complete');

    const results = await app.inject({ method: 'GET', url: `/extractions/${jobId}/results` });
    const body = results.json<GroupedResult>();
    expect(body.groupBy).toBe('category');
    expect(body.totalPlaces).toBeGreaterThan(0);
    expect(body.results[0]!['category']).toBe('Food & Drink');
    expect((body.results[0]!['places'] as ResolvedPlace[])[0]!.placeId).toBe('ChIJfixture');
  });

  it('defaults groupBy to category and honours an explicit dimension', async () => {
    const { app } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    const byCity = await app.inject({
      method: 'GET', url: `/extractions/${jobId}/results?groupBy=city`,
    });
    expect(byCity.json<GroupedResult>().groupBy).toBe('city');
    expect(byCity.json<GroupedResult>().results[0]!['city']).toBe('Barcelona');
  });

  it('rejects an unknown groupBy with 400', async () => {
    const { app } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    const bad = await app.inject({
      method: 'GET', url: `/extractions/${jobId}/results?groupBy=vibes`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns 404 for an unknown extraction', async () => {
    const { app } = buildTestServer();
    expect((await app.inject({ method: 'GET', url: '/extractions/nope' })).statusCode).toBe(404);
  });

  it('returns 409 when results are requested before the job completes', async () => {
    const { app, db } = buildTestServer();
    const { jobId } = (await startExtraction(app)).json<{ jobId: string }>();

    db.update(extractions).set({ status: 'running' }).where(eq(extractions.id, jobId)).run();

    const early = await app.inject({ method: 'GET', url: `/extractions/${jobId}/results` });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ status: string }>().status).toBe('running');
  });

  it('returns 400 for an unknown userId', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({
      method: 'POST', url: '/extractions', payload: { userId: 'ghost' },
    });
    expect(response.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/jobs/routes.test.ts`
Expected: FAIL — cannot resolve `../server.js`

- [ ] **Step 3: Write `src/jobs/routes.ts`**

```ts
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { GroupBy, ResolvedPlace } from '../domain/types.js';
import { extractions, places, users } from '../db/schema.js';
import { group } from '../group/index.js';
import { runExtraction, type PipelineDeps } from './pipeline.js';

const GROUP_BY_VALUES: GroupBy[] = ['category', 'city', 'country'];

export interface JobRouteDeps extends PipelineDeps {
  /**
   * Await the pipeline before responding. Tests set this so a request/response
   * cycle is deterministic; production leaves it false so POST returns 202 at once.
   */
  awaitPipeline?: boolean;
}

export async function jobRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: JobRouteDeps = {},
): Promise<void> {
  app.post<{ Body: { userId: string } }>('/extractions', async (request, reply) => {
    const { userId } = request.body ?? {};
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });

    const user = ctx.db.select().from(users).where(eq(users.id, userId)).all();
    if (!user[0]) {
      return reply.code(400).send({ error: `Unknown userId "${userId}". Authorize at GET /auth/google.` });
    }

    const jobId = randomUUID();
    const now = Date.now();
    ctx.db.insert(extractions).values({
      id: jobId, userId, status: 'pending', createdAt: now, updatedAt: now,
    }).run();

    const run = runExtraction(jobId, userId, ctx, deps);
    if (deps.awaitPipeline) await run;
    else void run;

    return reply.code(202).send({ jobId, status: 'pending' });
  });

  app.get<{ Params: { jobId: string } }>('/extractions/:jobId', async (request, reply) => {
    const rows = ctx.db.select().from(extractions)
      .where(eq(extractions.id, request.params.jobId)).all();
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'No such extraction.' });

    return reply.send({
      jobId: row.id,
      status: row.status,
      archiveJobId: row.archiveJobId,
      error: row.error,
    });
  });

  app.get<{ Params: { jobId: string }; Querystring: { groupBy?: string } }>(
    '/extractions/:jobId/results',
    async (request, reply) => {
      const rows = ctx.db.select().from(extractions)
        .where(eq(extractions.id, request.params.jobId)).all();
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'No such extraction.' });

      if (row.status !== 'complete') {
        return reply.code(409).send({
          error: `Extraction is ${row.status}, not complete.`,
          status: row.status,
        });
      }

      const groupBy = (request.query.groupBy ?? 'category') as GroupBy;
      if (!GROUP_BY_VALUES.includes(groupBy)) {
        return reply.code(400).send({
          error: `groupBy must be one of ${GROUP_BY_VALUES.join(', ')}.`,
        });
      }

      const stored = ctx.db.select().from(places)
        .where(eq(places.extractionId, row.id)).all();

      return reply.send(group(stored.map((p) => p.payload as ResolvedPlace), groupBy));
    },
  );
}
```

- [ ] **Step 4: Write `src/server.ts`**

```ts
import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { authRoutes } from './auth/routes.js';
import { jobRoutes, type JobRouteDeps } from './jobs/routes.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db/client.js';

export function buildServer(ctx: AppContext, deps: JobRouteDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(async (instance) => authRoutes(instance, ctx));
  app.register(async (instance) => jobRoutes(instance, ctx, deps));

  app.setErrorHandler((error, _request, reply) => {
    const status = error.name === 'ReauthRequiredError' ? 401
      : error.name === 'ConsentAlreadyUsedError' ? 409
      : 500;
    return reply.code(status).send({ error: error.message });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl);
  migrate(db);

  // awaitPipeline defaults to false, so POST /extractions returns 202 at once.
  const app = buildServer({ db, config });

  // Loopback only. /auth/reset is unauthenticated and destructive (it revokes
  // the Portability grant), and userId is derived from the Google sub, so the
  // listening socket is the only access control Phase 1 has.
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`TidyMap listening on http://localhost:${config.port}`);
  console.log(`Portability source: ${config.portabilitySource}`);
  console.log(`Start here: http://localhost:${config.port}/auth/google`);
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/jobs/routes.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS, every suite green

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/jobs/routes.ts src/jobs/routes.test.ts src/server.ts
git commit -m "feat: expose extraction endpoints and assemble the server"
```

---

## Task 12: Setup runbook and manual end-to-end verification

**Files:**
- Create: `README.md`, `docs/gcp-setup.md`

**Interfaces:**
- Consumes: the running server from Task 11
- Produces: no code

- [ ] **Step 1: Write `docs/gcp-setup.md`**

````markdown
# Google Cloud setup

TidyMap needs one GCP project with two APIs enabled and an OAuth client.

## 1. Create the project

1. Go to https://console.cloud.google.com/projectcreate
2. Name it `tidymap`. Note the project ID.

## 2. Enable billing

Places API (New) will not serve requests without a billing account attached.
Console → Billing → Link a billing account.

Phase 1 makes at most 20 Places calls per extraction. Text Search (New) bills
roughly $32 per 1,000 requests, so a run costs well under a dollar.

## 3. Enable the APIs

Console → APIs & Services → Enable APIs and Services. Enable both:

- **Data Portability API**
- **Places API (New)** — this is a separate product from the legacy "Places API"

## 4. Configure the OAuth consent screen

1. APIs & Services → OAuth consent screen
2. User type: **External**
3. Publishing status: leave as **Testing**
4. Under **Test users**, add your own Google account

> Testing mode allows up to 100 test users and needs no verification review.
> `dataportability.*` are restricted scopes — publishing to production requires
> Google's app verification, which takes weeks. Phase 1 stays in Testing.

## 5. Add the scopes

On the consent screen, add:

- `https://www.googleapis.com/auth/dataportability.saved.collections`
- `https://www.googleapis.com/auth/dataportability.maps.starred_places`
- `openid`
- `email`

## 6. Create the OAuth client

1. APIs & Services → Credentials → Create Credentials → OAuth client ID
2. Application type: **Web application**
3. Authorized redirect URI: `http://localhost:3000/auth/google/callback`
4. Copy the client ID and client secret

## 7. Create the Places API key

1. Credentials → Create Credentials → API key
2. Restrict it to the **Places API (New)**

## 8. Fill in `.env`

```bash
cp .env.example .env
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_PLACES_API_KEY`.
````

- [ ] **Step 2: Write `README.md`**

````markdown
# TidyMap

Organizes Google Maps saved places: exports them via the Data Portability API,
resolves each to a PlaceID with city, country and category, and returns them
grouped as JSON.

## Setup

See [docs/gcp-setup.md](docs/gcp-setup.md), then:

```bash
npm install
cp .env.example .env   # fill in the Google credentials
npm run dev
```

## Running without Google

Set `PORTABILITY_SOURCE=fixture` to run the whole pipeline against the
committed sample export in `fixtures/`. Only the Places API is called.

This is the normal development mode. Portability authorization is one-time-use,
so every live run costs a browser consent round-trip.

## End-to-end run

1. Open http://localhost:3000/auth/google and grant consent. The callback
   returns your `userId`.

2. Start an extraction:

   ```bash
   curl -X POST http://localhost:3000/extractions \
     -H 'content-type: application/json' \
     -d '{"userId":"YOUR_USER_ID"}'
   ```

3. Poll until `status` is `complete` — the archive typically takes a few minutes:

   ```bash
   curl http://localhost:3000/extractions/JOB_ID
   ```

4. Fetch the results:

   ```bash
   curl 'http://localhost:3000/extractions/JOB_ID/results?groupBy=category'
   curl 'http://localhost:3000/extractions/JOB_ID/results?groupBy=city'
   curl 'http://localhost:3000/extractions/JOB_ID/results?groupBy=country'
   ```

## Re-running an extraction

Portability authorization is `ACCESS_TYPE_ONE_TIME`. A second extraction
returns 409. To run again:

```bash
curl -X POST http://localhost:3000/auth/reset \
  -H 'content-type: application/json' \
  -d '{"userId":"YOUR_USER_ID"}'
```

Then re-authorize at `/auth/google` — the reset invalidates the existing
tokens, so consent must be repeated.

## Tests

```bash
npm test
```

Every test runs offline. No test calls Google.
````

- [ ] **Step 3: Verify the fixture path end to end**

```bash
PORTABILITY_SOURCE=fixture npm run dev
```

In another terminal, insert a user row directly and run an extraction against
the fixture export. Confirm the response matches the contract in the spec:
`groupBy`, `totalPlaces`, `unresolvedCount`, and a `results` array whose first
group key is `category`.

- [ ] **Step 4: Run the live end-to-end verification**

Follow the README steps 1–4 against your real Google account with
`PORTABILITY_SOURCE=live`. Record in the commit message:

- how long the archive job took
- how many of the 20 items resolved
- any `primaryType` values that landed in `Unknown` (these are gaps in the
  taxonomy table worth filling)
- whether saved-collection items without coordinates resolved to the right city

- [ ] **Step 5: Commit**

```bash
git add README.md docs/gcp-setup.md
git commit -m "docs: add setup runbook and end-to-end instructions"
```

---

## Verification checklist

Before declaring Phase 1 complete, confirm each with actual command output:

- [ ] `npx vitest run` — all suites pass
- [ ] `npx tsc --noEmit` — no type errors
- [ ] Fixture-mode extraction returns the contract shape from the spec
- [ ] `?groupBy=city` and `?groupBy=country` rename the group key correctly
- [ ] `?groupBy=vibes` returns 400
- [ ] A live extraction against a real account completes and resolves places
- [ ] A second live extraction without reset returns 409, not a crash
- [ ] An item that fails Places resolution appears with `resolved: false`, not missing
