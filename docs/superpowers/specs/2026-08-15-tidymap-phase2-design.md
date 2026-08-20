# TidyMap — Phase 2 Design

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning
**Builds on:** [Phase 1 design](2026-08-15-tidymap-mvp-design.md)

## Problem

Phase 1 outputs grouped JSON and nothing consumes it. Running an extraction means
curl, a hand-copied `userId`, and reading raw JSON. Two consequences: the tool is
unusable without a terminal, and the categorization quality is invisible.

Phase 2 adds a browser UI that drives the whole flow, surfaces categories with
emojis, and closes a Phase 1 todo: when a place cannot be categorized, fall back
to its sub-category rather than collapsing everything into `Unknown`.

## Scope

**In scope:** a static single-page UI served by Fastify; a cookie session; emojis
on category groups; `types[]`-based categorization rescue; sub-category grouping
fallback; `GET /extractions`.

**Out of scope:** extraction history browsing, place editing, export (CSV/GeoJSON/
KML), search, map views, multi-user support, and the Phase 1 deferred items listed
in `docs/HANDOFF.md`.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| UI delivery | Static page served by Fastify at `/` | No build step, no second dev server. Right-sized for a loopback single-user tool; swapping in a framework later needs no backend change |
| Session | `HttpOnly` cookie set by the OAuth callback | Keeps the opaque `userId` out of URLs and browser history — it is the main thing protecting `/auth/reset` |
| Emoji source | The taxonomy, returned by the API | One source of truth; a future client gets it free, matching how `domain/types.ts` is kept as a shared contract |
| Sub-category | Rescue via `types[]`, then group by raw type | Shrinks `Unknown` rather than merely relabelling it |
| Resumability | `GET /extractions` | Archive jobs take minutes; closing the tab must not orphan a running job |

## Backend changes

### Categorization gains a second chance

`categorize(primaryType)` becomes `categorize(primaryType, types?)`. It tries
`primaryType` against the lookup table, then walks `types[]` for the first entry
that maps. A place typed `yak_rental, tourist_attraction, point_of_interest`
lands in `Culture` instead of `Unknown`.

`enrich/` starts retaining `types[]` on `ResolvedPlace`. The Places field mask
already requests `places.types`; Phase 1 discarded it.

Unmapped-type counting still records the **`primaryType`** — that list is the
taxonomy-gap report, and recording rescued secondary types would pollute it.

### Grouping falls back to the sub-category

In `group()`'s `keyFor`, when grouping by category:

- category is a real bucket → use it, as today
- category is `Unknown` **and** `primaryType` exists → use the type rendered
  readably: underscores become spaces and each word is capitalised, so
  `yak_rental` → `Yak Rental`
- otherwise → `Unknown`

Existing sort rules need no special-casing: fallback groups are small, so
descending-count ordering sinks them below the curated categories.

**This means the ten curated categories are no longer the complete set of
possible group keys.** Anything downstream must not assume a closed set.

### Emoji on every group

`PlaceGroup` gains `emoji: string`, sourced from the taxonomy alongside the
type→category mapping. Fallback groups get a neutral default (📍).

No "this was uncategorized" marker is added. `warnings` already reports unmapped
type counts; duplicating that invites drift.

### Cookie session

`GET /auth/google/callback` stops returning JSON. It sets a cookie holding the
`userId` and redirects to `/`. The cookie is named `tidymap_uid`.

Cookie attributes, all load-bearing:

- `HttpOnly` — page scripts cannot read the id
- `SameSite=Lax` — **security-critical.** `/auth/reset` is unauthenticated and
  destructive. Cookie-borne identity would otherwise let any page in the browser
  POST to `localhost:3000/auth/reset` and revoke the grant. `Lax` withholds the
  cookie on cross-site POSTs. Today's protection — an unguessable `userId` —
  disappears the moment a cookie supplies identity automatically.
- `Path=/`
- `Max-Age` of 30 days, so closing the browser does not force a fresh consent —
  which matters because consent is one-time-use and expensive to repeat
- `Secure` omitted, because the server is `http://127.0.0.1`

`POST /extractions` and `POST /auth/reset` read identity from the cookie, falling
back to a body `userId` so existing curl workflows keep working. Cookie wins when
both are present.

### `GET /extractions`

Returns the caller's extractions — `jobId`, `status`, `createdAt` — newest first,
scoped to the cookie/body identity. Returns `401` when no identity is present;
the UI reads that as signed out. Lets it recover a running job after a reload.

### Static serving

Fastify serves `public/` at `/`. No build step.

## The UI

Three files under `public/`: `index.html`, `app.js`, `style.css`. Deliberately
plain; the substance is state handling.

### States

| State | Shows |
|---|---|
| Signed out | What the tool does; one "Connect Google" button → `/auth/google` |
| Ready | "Extract my saved places", noting it takes minutes and spends a one-time authorization |
| Running | Elapsed time, current status, and that Google is building the archive |
| Done | Grouped results |
| Failed | The `error` text plus guidance specific to the failure |

Resolved on load from `GET /extractions`: no cookie → signed out; no extractions →
ready; newest is `pending`/`running` → resume polling; `complete` → results;
`failed`/`timed_out` → failure.

### Polling

`GET /extractions/:jobId` every 3s, backing off to 10s after the first minute,
with elapsed time always visible. Archive jobs take minutes, and a spinner with no
feedback reads as hung well before the job is actually late.

### Results

Each group renders as a section: emoji, name, count. Places listed underneath with
name, address, and `note` when present. A three-way toggle switches `groupBy`
between category, city, and country; switching refetches. Regrouping is free —
places are already persisted and no Places call is repeated.

`warnings` renders as a dismissible strip when present. That is where taxonomy
gaps and skipped export files surface.

### The re-run path

This is where the UX budget goes, because it is the sharpest edge in Phase 1.

After a completed or failed run, the UI states that re-extracting requires the
Portability grant to be cleared first, links to
<https://myaccount.google.com/permissions>, and offers a reset button.

When a run fails with `RESOURCE_EXHAUSTED`, the UI presents the ambiguity
honestly — spent authorization *or* rate limiting — rather than instructing a
reset, because resetting a still-valid token is destructive and irreversible.

## Testing

`public/app-state.js` holds pure functions — which state to render from a server
response, group-label formatting, elapsed-time display — imported directly by
Vitest. `public/app.js` does DOM wiring and `fetch` and stays thin enough to
review by eye. No build step, and the logic that can be wrong is covered.

Backend tests follow the existing shape:

- `categorize` with a `types[]` array where `primaryType` does not map
- `group` producing a fallback key, and preserving `Unknown` for typeless places
- every group carrying an `emoji`
- the callback setting a cookie with `HttpOnly` and `SameSite=Lax`
- `POST /extractions` accepting cookie identity and body identity, cookie winning
- `GET /extractions` scoped to the caller

**Every one of these gets a mutation check** — break the behavior, confirm a test
fails, restore. Phase 1's recurring defect was tests that passed regardless of the
behavior they named, caught in all twelve tasks; the discipline stays.

## What this disturbs

**Old persisted places lack `types`.** Places are stored as JSON in
`places.payload`, so no migration is needed, but `categorize` and the UI must
treat `types` as absent rather than assume it. Pinned by a test that loads an
old-shaped payload.

**Categorization results change for places that already resolved.** A place
currently in `Unknown` may move into a real category. That is the intent, but it
means group keys are now an open set.

## Risk

All of this modifies code that has never completed a live run — Phase 1 reached
enrichment and failed there, and the fix is unverified against real data. The
`types[]` rescue path in particular can only be judged against real saved places:
it may reclassify most of the `Unknown` bucket or barely fire. The first live run
after this ships is the real test of whether the fallback design earns its keep.
