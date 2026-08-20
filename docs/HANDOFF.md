# TidyMap — session handoff

Written 2026-08-15, end of the Phase 1 build session.

## State at a glance

| | |
|---|---|
| `main` | `55832ae` — all work merged (PRs #1–#4) |
| Branch `worktree-tidymap-mvp` | even with `main` |
| Tests | 179 across 18 files, all passing |
| Typecheck | `npx tsc --noEmit` clean |
| Live end-to-end | **incomplete** — see below |

Phase 1 is code-complete and reviewed. It has never completed a full run against
real Google data.

## Run it

```bash
git pull && npm install
npm run dev          # NOT npm start unless you rebuilt — dist/ goes stale fast
```

Setup: [docs/gcp-setup.md](gcp-setup.md). Env vars: [README](../README.md).
**Back up `tidymap.db` before the first run of a new build** — startup performs a
real `users` table rebuild on pre-existing databases.

## How far the live run actually got

Proven against real data: **OAuth consent → initiateArchive → poll → download →
unzip → parse.** The export came back and parsed correctly.

Failed at: **enrichment.** A Places address component arrived with no `types`
array and crashed on `.includes()`. Fixed in `13a96ac` (guards + optional
`types`), but the fix has **not been exercised against live data**.

Then blocked on re-consent: the failed run left the Portability grant live, so
`/auth/google` returns *"Incremental auth is not allowed for the requested
scopes"*. Escape is a Google-side revoke at
<https://myaccount.google.com/permissions> — see the README section.

**So the first task next session is: revoke, re-consent, re-run, and see whether
enrichment completes.** Everything downstream of it (categorize, dedupe, group,
the JSON contract) has only ever run against fixtures.

## What to watch for on that run

- **Wrong-city matches.** Saved-collection items carry no coordinates, so their
  Places lookups have no `locationBias`. A generically-named place can resolve to
  the wrong city entirely. Check `city` values against what you actually saved.
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
   built — the obvious Phase 2 improvement.
8. **There is no write-back.** The Data Portability API is read-only, and no
   public Google API creates, modifies, or deletes Maps saved places or lists.
   TidyMap can never mutate the source. The nearest round-trip is exporting KML
   and importing to Google My Maps, which creates a separate map.

## Open product question

Phase 1 outputs JSON and nothing consumes it. Before building more, decide what
the artifact is:

1. **TidyMap becomes where you browse** — Phase 2 frontend is the product.
2. **Export is the product** — CSV/GeoJSON, listed as out-of-scope for Phase 1
   meaning "later", not "never".
3. **Round-trip via My Maps** — export KML, import as layers. Manual, but the
   only path that puts the result back inside a Google surface.

Not decided. Worth a proper design pass rather than drifting into one.

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

## Where the detail lives

- Spec: [docs/superpowers/specs/2026-08-15-tidymap-mvp-design.md](superpowers/specs/2026-08-15-tidymap-mvp-design.md) — amended throughout the build; describes intended final state.
- Plan: [docs/superpowers/plans/2026-08-15-tidymap-mvp.md](superpowers/plans/2026-08-15-tidymap-mvp.md) — 12 tasks, corrected as defects were found.
- **Build ledger**: `.superpowers/sdd/2026-08-15-tidymap-mvp/progress.md` — 414 lines,
  every finding, ruling and deferred minor from 12 task reviews plus a whole-branch
  review. **It is gitignored and lives only in the worktree.** If that worktree is
  removed it is gone; this file is the durable summary.

## One process note

Almost every defect found during the build originated in the plan, not in the
implementation — most often as a test that passed regardless of the behavior it
named. What caught them was requiring each implementer to *break* the behavior
deliberately and confirm a test failed. Three further defects (`API_KEY_INVALID`,
the scope-mixing rejection, the `types` crash) could only ever be found by
running the real thing. Worth keeping both habits.
