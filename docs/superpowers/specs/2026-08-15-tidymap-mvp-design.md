# TidyMap — Phase 1 (MVP) Design

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning

## Problem

Google Maps saved pins accumulate into flat, unusable lists. There is no grouping, no
export, no way to answer "what did I save in Lisbon?" TidyMap pulls a user's saved places
out of Google via the Data Portability API, resolves each one to a real place record, and
returns them grouped by category, city, or country.

Phase 1 delivers the end-to-end backend flow with no frontend. Output is plain JSON.

## Scope

**In scope:** Google OAuth, Data Portability export, parsing, Places API enrichment,
categorization, grouping, HTTP endpoints, SQLite persistence, fixture-based offline mode.

**Out of scope:** frontend, CSV/GeoJSON export, real multi-user support, background job
queue, more than 20 places per extraction, Google app-verification submission.

## Key constraint discovered during design

**The Portability export contains no PlaceIDs.**

- `saved.collections` → CSV: `collection_description`, `title`, `note`,
  `item_content_url`, `tags`, `comment`. No coordinates, no IDs.
- `maps.starred_places` → GeoJSON: `name`, `address`, `coordinates`. No IDs, no country code.

PlaceID, category, city, and country must therefore be **resolved** through the Places API
from name + address + coordinates. This is a distinct pipeline stage, and it is the only
stage that costs money.

A second constraint: Portability authorization is `ACCESS_TYPE_ONE_TIME`. Every real export
consumes the consent and requires `authorization:reset` before another. This is why fixture
mode exists from day one rather than as a later convenience.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Stack | TypeScript / Node, Fastify | Official `googleapis` client covers both APIs; same language as the future frontend; shared types for mobile |
| Persistence | SQLite via Drizzle | Survives restarts, so a completed export is not re-fetched at the cost of a consent reset. Drizzle keeps the Postgres path open |
| Taxonomy | Curated ~10-bucket lookup table | Deterministic and unit-testable. Raw `primaryType` is retained on every place so nothing is lost |
| Flow shape | HTTP backend with job records | Phase 2 adds a frontend against these same endpoints with no rewrite |
| Repo shape | Single package, `src/` | YAGNI. Contract types isolated in `src/domain/types.ts` for later extraction into `packages/shared` |

## Architecture

Nine modules. Everything after `parse/` is pure and network-free.

| Module | Responsibility | Depends on |
|---|---|---|
| `auth/` | OAuth code flow, token persistence, consent reset | `db/` |
| `portability/` | `initiateArchive` / `getArchiveState` / `resetAuthorization`. Knows nothing about Maps | — |
| `archive/` | Download signed URLs, unzip, persist raw blobs | `db/` |
| `parse/` | Raw export files → normalized `SavedItem[]`; drops non-place saves | — |
| `enrich/` | `SavedItem` → `ResolvedPlace` via Places API. Sole source of PlaceID/city/country | Places API, cache |
| `categorize/` | `primaryType` → category. Pure lookup | — |
| `group/` | `(ResolvedPlace[], groupBy)` → grouped JSON. Pure | — |
| `jobs/` | Pipeline orchestration and job status | all above |
| `db/` | Drizzle + SQLite | — |

**Tables:** `users`, `oauth_tokens`, `extractions`, `raw_artifacts`, `places`.

## HTTP surface

```
GET  /auth/google                  → 302 to Google consent
GET  /auth/google/callback         → exchange code, persist tokens
POST /auth/reset                   → reset Portability consent (allows re-export)
POST /extractions                  → { jobId }
GET  /extractions/:jobId           → { status, progress, error? }
GET  /extractions/:jobId/results   → grouped JSON (?groupBy=category|city|country)
```

Job status is one of `pending`, `running`, `complete`, `failed`, `timed_out`.

## Pipeline

```
POST /extractions
   │
   ├─ 1. initiateArchive(token, ["saved.collections", "maps.starred_places"])
   │        → { archiveJobId, accessType: ACCESS_TYPE_ONE_TIME }
   │
   ├─ 2. poll getArchiveState — backoff 2s → 4s → 8s, capped at 30s, abandon at 15 min
   │        → { state: COMPLETE, urls: [signed…] }
   │
   ├─ 3. download + unzip → persist to raw_artifacts
   │        ← every later stage runs offline against these stored bytes
   │
   ├─ 4. parse → SavedItem[]
   │        drop non-place saves (shopping/, imgres?, search?q= URLs)
   │
   ├─ 5. take first 20        ← cap applied BEFORE any paid call
   │        stable order: starred_places first, then saved.collections
   │        (lists alphabetical), preserving row order within each file
   │
   ├─ 6. enrich → Places API searchText, one call per item
   │
   ├─ 7. categorize (pure) → 8. dedupe by placeId → 9. group (pure)
   │
   └─ GET /extractions/:jobId/results
```

Both scopes are requested because they are different datasets and a place may appear in
both. Deduplication happens after enrichment, keyed on resolved `placeId`, merging
`sourceLists` into an array so list membership is preserved.

### Normalized `SavedItem`

```ts
{ sourceId, title, address?, lat?, lng?, mapsUrl?, note?, sourceList }
```

### Enrichment call

`POST https://places.googleapis.com/v1/places:searchText`

- `textQuery` — title, plus address when present
- `locationBias` — 500m circle around coordinates, **when available**. Starred places have
  coordinates; saved-collection items do not.
- `X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.primaryType,places.types,places.location,places.addressComponents`

City is extracted from `addressComponents` with a fallback chain: `locality` →
`postal_town` → `administrative_area_level_2`. `locality` is absent in UK addresses and
several other countries, so the chain is required, not defensive. Country takes both
`longText` (name) and `shortText` (ISO code) — note the Places API **(New)** field names,
not the legacy `long_name` / `short_name`.

Responses are cached by normalized query so re-runs never re-bill.

## Output contract

The group key is named after the dimension grouped by.

```json
{
  "groupBy": "category",
  "totalPlaces": 20,
  "unresolvedCount": 1,
  "results": [
    {
      "category": "Food & Drink",
      "places": [{
        "placeId": "ChIJ...",
        "name": "Satan's Coffee Corner",
        "address": "Carrer de l'Arc de Sant Ramon del Call, 11, Barcelona",
        "city": "Barcelona",
        "country": "Spain",
        "countryCode": "ES",
        "category": "Food & Drink",
        "primaryType": "cafe",
        "lat": 41.3825,
        "lng": 2.1769,
        "sourceLists": ["Want to go", "Starred places"],
        "mapsUrl": "https://...",
        "note": "cortado",
        "resolved": true
      }]
    }
  ]
}
```

`?groupBy=city` swaps the key to `"city"`; `?groupBy=country` to `"country"`. When the
parameter is omitted the default is `category`; any other value is a 400. Groups are
ordered by descending place count, ties broken alphabetically by key, so output is stable
across runs.

**Unresolved places are kept, never dropped** — `resolved: false`, `category: "Unknown"`,
with whatever fields are known. Silently losing a user's saved pin is the worst failure
this application can have.

## Taxonomy

| Category | Covers |
|---|---|
| Food & Drink | restaurant, cafe, bakery, bar, ice_cream_shop, all `*_restaurant` |
| Nightlife | night_club, pub, casino, comedy_club |
| Lodging | hotel, hostel, guest_house, campground, resort_hotel |
| Shopping | store, market, mall, book_store, clothing_store |
| Outdoors | park, beach, hiking_area, national_park, garden |
| Culture | museum, art_gallery, historical_landmark, tourist_attraction, places of worship |
| Entertainment | movie_theater, stadium, amusement_park, zoo, aquarium |
| Services | bank, hospital, pharmacy, gym, spa, hair_salon |
| Transport | airport, train_station, subway_station, parking |
| Unknown | unresolved, or a `primaryType` with no mapping |

Unmapped types fall to `Unknown` and are logged with an occurrence count, so gaps in this
table surface from real data rather than speculation.

## Failure handling

| Failure | Behavior |
|---|---|
| Second `initiate` without reset | 409 with explicit "consent already used, POST /auth/reset" |
| Archive `FAILED` / `CANCELLED` | Job → `failed`, Google's reason surfaced verbatim |
| Poll exceeds 15 min | Job → `timed_out`, **jobId retained** so polling resumes. Never re-initiate — that burns the consent |
| Places returns no match | Item kept with `resolved: false`. Not an error |
| Places 429 / 5xx | Retry with backoff; on exhaustion that item is unresolved and the job still completes |
| Expired refresh token | 401 with re-auth link |
| Places API key missing | Rejected at startup by config validation, naming the variable |
| Places billing not enabled | The first 403 throws and aborts the extraction with an explicit billing message. Not retried — every later call would fail identically, so 20 confusing 403s are avoided without a paid startup probe |

## Fixture mode

`PORTABILITY_SOURCE=fixture` reads a committed sample export from `fixtures/` instead of
calling Google, and `enrich/` reads recorded Places responses. This exists because the
one-time authorization makes every real run cost a browser-based consent reset —
without it, iterating on parsing logic is untenable.

## Testing

- **Unit** — taxonomy table, `group`, both parsers, and city/country extraction with cases
  for US, UK, Spain, and Japan (the `locality` fallback chain is the fragile part).
- **Integration** — full parse → enrich → group over committed fixtures, no network,
  asserting the exact JSON contract above.
- **Recorded responses** — one real Places response per category bucket.
- **Manual E2E** — a documented runbook against a real account, executed once after GCP setup.

## Prerequisites (greenfield — nothing exists yet)

The implementation plan must include a setup runbook:

1. Create a GCP project.
2. Enable **Data Portability API** and **Places API (New)**.
3. Attach a billing account (Places fails without it).
4. Configure the OAuth consent screen in **Testing** status, add the developer as a test user.
5. Add scopes `.../auth/dataportability.saved.collections` and
   `.../auth/dataportability.maps.starred_places`.
6. Create a Web OAuth client with the local callback URL.

## Verified API details

- `portabilityArchive:initiate` takes `resources` as scope suffixes — the quickstart shows
  `{"resources":["myactivity.search"]}`, so ours is
  `{"resources":["saved.collections","maps.starred_places"]}`.
- Poll `GET https://dataportability.googleapis.com/v1/archiveJobs/{jobId}/portabilityArchiveState`.
- Reset via `POST https://dataportability.googleapis.com/v1/authorization:reset`, which
  returns an empty body and invalidates previously issued tokens — so a reset requires a
  fresh consent round-trip, not just a new `initiate`.

## Known risks

1. **Verification is a wall for public launch.** `dataportability.*` are restricted scopes.
   Testing mode caps at 100 test users and consent expires periodically. Public release
   requires Google's verification review — weeks, not days. Phase 1 is unaffected, but any
   timeline beyond it is.

2. **Saved-collection items have no coordinates.** Without `locationBias`, a text search for
   a generic name ("Blue Bottle") can resolve to the wrong city. Phase 1 accepts this and
   reports it through `resolved`. If accuracy proves poor on real data, extracting the
   `!3m1!1s0x…` ftid from the Maps URL is the Phase 2 mitigation.
