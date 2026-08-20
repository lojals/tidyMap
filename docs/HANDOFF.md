# TidyMap — session handoff

Written 2026-08-15, end of the Phase 1 build session.
Updated 2026-08-20, end of the Phase 2 build session (Task 7 — docs and
fixture-mode verification). Phase 1 content below is left as written; new
material is in the sections marked Phase 2.

## State at a glance

| | |
|---|---|
| `main` | `55832ae` at Phase 1 handoff — Phase 2 not yet merged |
| Branch `worktree-tidymap-mvp` | Phase 2 code-complete; Task 7 started at HEAD `f2f7ed2`, and this doc commit lands on top of `0e2e2d3` (a client-side polling/error-handling fix that landed mid-Task-7, not authored as part of this task — see note below) |
| Tests | 228 across 20 files, all passing |
| Typecheck | `npx tsc --noEmit` clean |
| Live end-to-end (real OAuth + Portability archive) | **still incomplete** — unchanged since Phase 1, see below |
| Fixture-mode + real Places API | run 2026-08-20 (Task 7) — see "Phase 2: what actually got verified" below |

Phase 1 is code-complete and reviewed. It has never completed a full run against
real Google data.

Phase 2 shipped on top of that: categorization rescue via the Places
`types[]` array, group emojis and sub-category fallback grouping, an HttpOnly
`SameSite=Lax` session cookie (`tidymap_uid`), `GET /extractions`, the
`public/` browser UI served with no build step, and a pure UI state module.
It is also code-complete and reviewed task-by-task, but — like Phase 1 at its
handoff — **has never been exercised against a real Google Portability
archive.** See "Phase 2: what actually got verified" below for exactly how
far Task 7's verification did and did not go.

## Run it

```bash
git pull && npm install
npm run dev          # NOT npm start unless you rebuilt — dist/ goes stale fast
```

Setup: [docs/gcp-setup.md](gcp-setup.md). Env vars: [README](../README.md).
**Back up `tidymap.db` before the first run of a new build** — startup performs a
real `users` table rebuild on pre-existing databases.

**Phase 2 trap, cost real debugging time in Task 7:** on this machine, some
unrelated process intercepts `localhost:3000` over IPv6 — requests to
`http://localhost:3000/...` silently hang or misbehave. The server itself
binds `127.0.0.1` only (IPv4), so `localhost` and the actual bind address
are not the same target here. When testing manually with curl or a browser,
target `http://127.0.0.1:3000/` explicitly rather than `localhost`.

## How far the live run actually got

Proven against real data: **OAuth consent → initiateArchive → poll → download →
unzip → parse.** The export came back and parsed correctly.

Failed at: **enrichment.** A Places address component arrived with no `types`
array and crashed on `.includes()`. Fixed in `13a96ac` (guards + optional
`types`). As of Phase 2 Task 7, this fix **has** now been exercised against
real Places API responses (see "Phase 2: what actually got verified" below)
— but that was fixture-mode, not a live Portability archive, so it is
partial confidence, not the full proof the next live run would give.

Then blocked on re-consent: the failed run left the Portability grant live, so
`/auth/google` returns *"Incremental auth is not allowed for the requested
scopes"*. Escape is a Google-side revoke at
<https://myaccount.google.com/permissions> — see the README section.

**So the first task next session is still: revoke, re-consent, re-run, and see
whether the full pipeline completes end to end.** This has not changed since
Phase 1 — Phase 2 added features on top of the same untested-live foundation,
it did not retire this item.

## Phase 2: what actually got verified

Task 7 (2026-08-20) ran the server with `PORTABILITY_SOURCE=fixture` against
a scratch SQLite database and a real `GOOGLE_PLACES_API_KEY`, seeding a
`users` row directly with a throwaway script (fixture mode still requires
one, and only the OAuth callback creates it in normal operation — see the
README's "Running without Google" section). This is **not** the live
end-to-end run described above: it replaces the Portability Archive API with
the committed sample export in `fixtures/`, so OAuth consent and the real
archive job lifecycle were not touched. What it does cover is everything
downstream of that — parse, dedupe, enrich (against the real Places API),
categorize, group — for the first time against live Places responses rather
than mocked ones.

Confirmed, with real output:

1. `GET /` serves the page — `200`.
2. `GET /extractions` with no cookie — `401 {"error":"Not signed in."}`.
3. `POST /extractions` with a seeded user's id as the `tidymap_uid` cookie —
   `202` with a `jobId`.
4. `GET /extractions/:jobId/results?groupBy=category` — every group carried
   an `emoji` (`Food & Drink` → 🍽️, `Outdoors` → 🌳).
5. **Not exercised, but for a different reason than first recorded here** —
   corrected below after review caught the original explanation was wrong.
   All 4 fixture places (Satan's Coffee Corner, Time Out Market, Bar Cañete,
   Park Güell) resolved cleanly to a known category — `unresolvedCount: 0`,
   no `Unknown` bucket, `warnings: null`. So the specific behavior point 5
   checks for — an uncategorized place grouping under a readable type
   instead of `Unknown` — genuinely never fired, because no place ended up
   uncategorized. That part was right.

   What was wrong: the original text here claimed this was because "the
   fixture set happens not to contain a place whose `primaryType` falls
   outside the taxonomy table." That's false. Time Out Market's
   `primaryType` is `food_court`, which is **absent** from
   `TYPE_TO_CATEGORY` in `src/categorize/taxonomy.ts` and doesn't match the
   `_restaurant` suffix rule either — the direct lookup genuinely fails for
   it. It landed in Food & Drink anyway because of the Task 1 secondary-type
   rescue in `categorize()`: Time Out Market's `types` array was
   `["food_court", "bar", "restaurant", "food", "point_of_interest",
   "establishment"]`, and the rescue loop's first mapped hit, `bar`, sent it
   to Food & Drink before it ever reached the `Unknown` fallback. **That is
   the `types[]` rescue mechanism firing for the first time against live
   Google data** — previously verified only in unit tests
   (`src/categorize/taxonomy.test.ts`) — and this document should have
   credited it instead of asserting a taxonomy gap that isn't there. Point
   5's own readable-type-fallback path is still genuinely unexercised; worth
   redoing the next time a live or fixture run turns up a `primaryType`
   with *no* mappable secondary type either.

One more thing worth recording precisely because it can't be faked: the
fixture's "Satan's Coffee Corner" resolved to Google's real current listing
name for that address, **"Right Side Coffee Bar"** — an actual business
rename this run picked up live. A replayed or mocked Places response would
echo the name it was given; only a genuine `places:searchText` call against
Google's live index would return a name that doesn't match the input at
all. Of everything in this verification, that single detail is the hardest
to dismiss as a fixture artifact.

`npx vitest run` (228/228) and `npx tsc --noEmit` were also re-run clean
after this verification.

**Note on the test/commit counts above:** commit `0e2e2d3` ("fix: handle a
failed results fetch and a dropped poll in the extraction UI") landed on
this branch mid-Task-7, after the live curl verification above but before
the final full-suite re-run — it is not part of this documentation task and
was not authored as part of it. It only touches `public/app.js` and
`public/app-state.js` (client-side polling/error handling), so it does not
affect anything the five verification points above check, all of which are
server-side. Flagging it here mainly because Task 7's brief described the
branch as sitting still at `f2f7ed2` with only a read-only reviewer active
alongside it; a real commit landing anyway is worth a future session
knowing about, in case it signals the "no other writers" assumption doesn't
always hold in this environment.

## What to watch for on that run

- **Wrong-city matches.** Saved-collection items carry no coordinates, so their
  Places lookups have no `locationBias`. A generically-named place can resolve to
  the wrong city entirely. Check `city` values against what you actually saved.
- **Phase 2 data point on that risk — not a resolution.** In Task 7's fixture-mode
  verification, two of the four resolved places (Bar Cañete, Park Güell) came only
  from the saved-collections CSV and so had exactly the no-`locationBias` condition
  above; both landed correctly in Barcelona. n=2, drawn from a hand-picked fixture
  set, not a real user's saved places — far too small a sample to retire the risk
  described above, but the first evidence in either direction. The caution stands.
- **Taxonomy gaps.** The category table was written from documentation, never
  against real data. Unmapped `primaryType` values are counted and surface in the
  `warnings` field of `GET /extractions/:jobId`. That is your gap list.
- **Errors now name the stage** and the offending place's title. Earlier failures
  did not, which cost real debugging time.

## Constraints learned the hard way

These were all discovered *during* the build, several only by running the thing.
They are not obvious from the docs and they shaped the design.

1. **The Portability export contains no PlaceIDs.** Not city or country either.
   All of it is resolved via the Places API — the only stage that costs money,
   which is why the 20-item cap is applied before enrichment.
2. **Portability scopes cannot be mixed with any other scope.** Requesting
   `openid`/`email` alongside them fails with `Error 400: invalid_request`. The
   returned token is **opaque** — there is no `id_token` and the app never learns
   which account consented. Identity by `sub` is impossible.
3. **Consequence of (2): every consent creates a new `users` row.** There is no
   way to recognise a returning user. This creates a recovery trap — `/auth/reset`
   needs the tokens of whichever user holds the *live* grant, so losing track of
   that `userId` means only a Google-side revoke can unstick consent.
4. **An invalid Places key returns `400 API_KEY_INVALID`, not 401/403.** Before
   the fix this fell through to `return null` and silently marked every place
   unresolved while reporting `status: "complete"`. 400 is now fatal.
5. **`RESOURCE_EXHAUSTED` is ambiguous** — Google returns it for both a spent
   one-time authorization and ordinary rate limiting. `/auth/reset` is
   destructive, so do not reset on that signal alone.
6. **`archiveJobs` carries no free-text failure reason.** `FAILED` vs `CANCELLED`
   is the entire signal available.
7. **Fixture mode is not offline.** It replaces only the Portability export; the
   Places API is still called and billed, and a `users` row is still required
   (which only OAuth creates). Recorded Places responses were specified but never
   built in Phase 1 — flagged then as "the obvious Phase 2 improvement," but
   Phase 2 shipped the UI and session/grouping work instead and did not build
   it either. Still open; a real candidate for whatever comes after Phase 2.
8. **There is no write-back.** The Data Portability API is read-only, and no
   public Google API creates, modifies, or deletes Maps saved places or lists.
   TidyMap can never mutate the source. The nearest round-trip is exporting KML
   and importing to Google My Maps, which creates a separate map.

## Open product question

Phase 1 outputs JSON and nothing consumes it. Before building more, this
handoff asked whoever picked it up to decide what the artifact is:

1. **TidyMap becomes where you browse** — Phase 2 frontend is the product.
2. **Export is the product** — CSV/GeoJSON, listed as out-of-scope for Phase 1
   meaning "later", not "never".
3. **Round-trip via My Maps** — export KML, import as layers. Manual, but the
   only path that puts the result back inside a Google surface.

**Phase 2 update:** option 1 is what got built — `public/` is a browser page
you use to trigger an extraction and browse the grouped results, not just a
JSON API. That was a build decision, not a documented product-strategy
review of the three options above, so treat it as "this is what shipped,"
not as a closed-out decision record. Options 2 and 3 (export formats,
My Maps round-trip) remain undone and are still on the table for whatever
comes after Phase 2.

## Known issues, not blocking

- `PlaceSearchResult.id` is typed required but flows into `placeId: string | null`.
  An omitted `id` yields `undefined` rather than `null`. Cannot crash — the falsy
  check still routes to unresolved — but it is the same type-dishonesty class that
  caused the `types` crash.
- Concurrent extractions interleave their `warnings` (process-global registries +
  fire-and-forget pipeline). Places are unaffected. Single-user loopback makes it
  moot for now.
- `places-client` puts up to 300 bytes of Google's error body into
  `extractions.error`, which is served over HTTP. Not a credential leak — the key
  travels in a header — but `portability/client.ts` does the same and it deserves
  one consistent ruling.
- No route ties a `jobId` to a requesting user; no concurrency guard on
  `POST /extractions`. Both consistent with the loopback-only access model.

## Security posture (do not silently change)

The server binds `127.0.0.1`. `POST /auth/reset` is unauthenticated and
destructive. `userId` is an opaque UUID, which is the main thing making that
route hard to target. Fastify runs with `logger: false` **for a reason** — the
OAuth authorization code arrives as a query parameter and default request logging
would write it to stdout. Do not enable logging without redaction, and do not
change the bind host without adding real authentication.

**Phase 2 addition:** identity can now also arrive via the `tidymap_uid`
session cookie (`src/auth/identity.ts`), not just a body `userId`. Once a
cookie supplies identity automatically, the browser will attach it to *any*
request to this origin — including one triggered by another page — so the
opaque `userId` alone no longer protects `/auth/reset`; `sameSite: 'lax'` on
that cookie is the control actually doing that job now. It is `httpOnly` too
(page scripts can't read it) but not `secure` (deliberate — the server is
plain `http` on loopback only). Do not weaken `sameSite` or add `secure`
without also moving off plain `http`, and do not add a cross-origin CORS
policy that would let another origin ride the cookie.

## Where the detail lives

- Spec (Phase 1): [docs/superpowers/specs/2026-08-15-tidymap-mvp-design.md](superpowers/specs/2026-08-15-tidymap-mvp-design.md) — amended throughout the build; describes intended final state.
- Plan (Phase 1): [docs/superpowers/plans/2026-08-15-tidymap-mvp.md](superpowers/plans/2026-08-15-tidymap-mvp.md) — 12 tasks, corrected as defects were found.
- **Build ledger (Phase 1)**: `.superpowers/sdd/2026-08-15-tidymap-mvp/progress.md` — 414 lines,
  every finding, ruling and deferred minor from 12 task reviews plus a whole-branch
  review. **It is gitignored and lives only in the worktree.** If that worktree is
  removed it is gone; this file is the durable summary.
- Spec (Phase 2): [docs/superpowers/specs/2026-08-15-tidymap-phase2-design.md](superpowers/specs/2026-08-15-tidymap-phase2-design.md)
- Plan (Phase 2): [docs/superpowers/plans/2026-08-15-tidymap-phase2.md](superpowers/plans/2026-08-15-tidymap-phase2.md) — 7 tasks, this handoff update is the last of them.
- **Build ledger (Phase 2)**: `.superpowers/sdd/2026-08-15-tidymap-phase2/progress.md` —
  same gitignored, worktree-only status as the Phase 1 ledger above; this file is
  again the durable summary once the worktree goes away.

## One process note

Almost every defect found during the build originated in the plan, not in the
implementation — most often as a test that passed regardless of the behavior it
named. What caught them was requiring each implementer to *break* the behavior
deliberately and confirm a test failed. Three further defects (`API_KEY_INVALID`,
the scope-mixing rejection, the `types` crash) could only ever be found by
running the real thing. Worth keeping both habits.
