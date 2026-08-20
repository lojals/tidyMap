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

The database schema is created automatically on startup (`src/db/client.ts`
runs idempotent `CREATE TABLE IF NOT EXISTS` statements — there is no
`drizzle-kit` migration step and nothing else to run first). One exception:
if your `.db` file predates the removal of `users.google_sub`/`users.email`,
startup also performs a one-time, **destructive** rebuild of the `users`
table (SQLite's documented table-rebuild procedure — see the comment above
`migrateUsersTableShape` in `src/db/client.ts`) to reach the current schema.
It runs inside a transaction and rolls back on any foreign-key violation
rather than leaving the database half-migrated, but rebuilding a table is
never risk-free — **copy your `.db` file somewhere safe before starting the
app for the first time after pulling this change.**

`npm start` runs the compiled `dist/`, not `src/` directly — after pulling
changes, refresh a stale build with `npm run build` before `npm start`, or
just use `npm run dev` (`tsx watch`), which always runs current source and
has no build step to forget.

### If `localhost:3000` doesn't connect

The server binds `127.0.0.1` (IPv4) only. On a system where `localhost`
resolves to `::1` (IPv6) first, `http://localhost:3000` will fail to
connect even though the server is running — this happened during Phase 2
verification on the development machine, where an unrelated process was
also listening on `localhost:3000` over IPv6.

If that happens, `http://127.0.0.1:3000` reaches the server — **but you
must then use `127.0.0.1` consistently everywhere**, including changing the
authorized redirect URI in the Google Cloud console and
`GOOGLE_REDIRECT_URI` in `.env` to match. Mixing the two hosts silently
strands the session cookie, because it is host-scoped: you'll appear signed
out on one host while holding a valid session on the other, and
re-consenting spends a one-time authorization to no effect. The default
path (`localhost` everywhere, as used throughout this README) works and is
what you should use unless you actually hit this.

## Using the web UI

`npm run dev` (or `npm start` against a fresh build) serves the whole app —
API and UI — on one port. Open <http://localhost:3000/> and click **Connect
Google**. That sends you through the same `/auth/google` consent flow the
curl walkthrough below uses; the callback now sets an HttpOnly session
cookie and redirects you straight back to `/` instead of showing you
anything to copy. Click **Extract my saved places** and wait — a real run
takes a few minutes, and the page polls and shows progress while Google
builds the archive. When it completes, results are grouped by category by
default, with **Category** / **City** / **Country** tabs to switch the
grouping; each group carries an emoji next to its name. The page has five
states (signed out, ready to extract, running, done, failed) and recovers
its place on reload by asking `GET /extractions` for your most recent job.

The UI is plain static files served from `public/` via `@fastify/static` —
there is no build step, no bundler, and no framework. `public/app.js` talks
to the same JSON endpoints documented below; `public/app-state.js` is a pure,
DOM-free module (view selection, elapsed-time formatting, poll backoff,
failure messaging) that is unit-tested the same way the server code is.

This does not replace the curl workflows below — both remain fully valid.
Every endpoint that needs identity (`POST /extractions`, `GET /extractions`,
`POST /auth/reset`) accepts a `userId` in the request body as a fallback,
and prefers the session cookie only when both are present
(`identityFrom` in `src/auth/identity.ts`). Since the cookie is `HttpOnly`,
scripting against these endpoints with curl still means capturing a
`userId` by hand — see the note in the end-to-end checklist below.

## Categorization

Every place is mapped to one of ten curated categories (`src/categorize/taxonomy.ts`)
from its Places `primaryType` first. If `primaryType` has no entry in the
table, Phase 2 added a rescue: the first mappable entry in the place's
`types[]` array is used instead — Google often reports a useless primary
type alongside a perfectly good secondary one (`yak_rental, tourist_attraction`
resolves to Culture, not Unknown). Only a place that finds no mapping in
either `primaryType` or `types[]` is counted as a taxonomy gap; see the
"Which `primaryType` values are taxonomy gaps" note below for how to find
those.

**Sub-category fallback grouping.** When grouping results by category
(`GET /extractions/:jobId/results?groupBy=category`, `src/group/index.ts`),
a place that ended up Unknown gets a second chance at a useful label: if it
has a `primaryType`, that type is turned into a readable group name of its
own (`yak_rental` → "Yak Rental") instead of joining one undifferentiated
`Unknown` pile. This applies per distinct `primaryType`, so different
unmapped types land in different groups rather than merging. Only a place
with no `primaryType` at all — nothing to build a readable name from —
still lands in the literal `Unknown` group. Fallback groups carry a neutral
📌 marker instead of a category emoji, so they read as distinct from the
ten curated categories at a glance.

## Security posture (Phase 1)

The server binds `127.0.0.1` only — it is not reachable from other machines
on the network, even if your firewall would otherwise allow it. This is
deliberate, not incidental: `POST /auth/reset` is unauthenticated, and the
loopback binding is Phase 1's only access control. Do not change the bind
host without adding real authentication first.

`userId` is a `randomUUID()` minted server-side on each consent
(`persistTokens` in `src/auth/oauth.ts`) — not derived from anything Google
returns. This is a consequence of the OAuth flow, not a hardening choice:
Google's Data Portability scopes cannot be requested alongside `openid` or
`email`, so the token exchange never yields an `id_token` and this server has
no Google-supplied identifier to key off. The upshot for `POST /auth/reset`
is favorable — an opaque random `userId` is far harder to guess or enumerate
than the old `user_<sub>` scheme was — but it is not a substitute for the
loopback binding, which remains the primary control.

**Cost of anonymity:** because the flow never learns which Google account
consented, this server cannot recognize a returning user. **Every completed
consent creates a new `users` row** — there is no dedup, and none is
possible without an identifier to dedup on. Running `GET /auth/google`
repeatedly (including every re-authorization after a token reset) will
accumulate rows in the `users` table. This is expected, not a leak to chase.

## Running without Google

Set `PORTABILITY_SOURCE=fixture` to run the whole pipeline against the
committed sample export in `fixtures/`. Only the Places API is called.

This is the normal development mode. Portability authorization is one-time-use,
so every live run costs a browser consent round-trip. Note that a valid
`GOOGLE_PLACES_API_KEY` is still required in fixture mode — see
[docs/gcp-setup.md](docs/gcp-setup.md).

**Gap:** fixture mode still needs a `users` row to exist before you can call
`POST /extractions` — that route looks up `userId` in the `users` table and
returns `400` for an unknown one, and the *only* code path that inserts a
`users` row is the `/auth/google/callback` handler in `src/auth/routes.ts`.
So "run without Google" is not actually Google-free end to end: you must
either complete one real consent round-trip at `GET /auth/google` first (to
mint a `userId`), or seed a `users` row into the SQLite database by hand
before your first `POST /extractions`. `PORTABILITY_SOURCE=fixture` only
skips the Portability Archive API for that user's *extractions* — it does not
skip account creation.

If you build from source (`npm run build && npm start`), fixture mode also
needs `fixtures/` to exist next to `dist/` at the repo root — `npm run build`
(plain `tsc`) does not copy it, since it is not a `.ts` source file. Running
`node dist/server.js` from within a full checkout of this repo works (fixture
resolution is anchored to the compiled module's own location, not the
working directory you launch it from); a `dist/` shipped on its own, without
the rest of the repository, cannot use fixture mode.

## OAuth flow and CSRF protection

`GET /auth/google` mints a random `state` value, stores it in the
`oauth_states` table, and redirects to Google with it attached. The callback
(`GET /auth/google/callback`) rejects any request whose `state` does not
match a stored, unexpired row — this is what stops an authorization code
injection attack (someone driving the callback with a code obtained through
some other channel). Each `state` is single-use (deleted on first use,
whether or not it validated) and expires after 10 minutes.

## End-to-end run (live — requires your own Google Cloud project)

This section is a checklist for you to run by hand against your own account,
after completing [docs/gcp-setup.md](docs/gcp-setup.md) and setting
`PORTABILITY_SOURCE=live` (or leaving it unset — `live` is the default). It
has **not** been executed as part of this repository's automated
verification: it requires a real GCP project, a real Google account, and a
browser consent round-trip that no automated check can perform. Fixture-mode
verification exercises the same code path end-to-end minus the Portability
API itself, and *has* been run against a real `GOOGLE_PLACES_API_KEY` — see
"How far the live run actually got" in [docs/HANDOFF.md](docs/HANDOFF.md)
for what that did and did not cover.

- [ ] 1. Open http://localhost:3000/auth/google and grant consent. As of
      Task 3, the callback no longer returns your `userId` in the response —
      it sets an HttpOnly `tidymap_uid` session cookie and redirects you to
      `/`. If you're driving the UI, that's the whole step: the browser
      carries the cookie automatically from here on and you never need the
      raw value. If you want to script the rest with curl instead, the
      cookie being `HttpOnly` means page JavaScript can't read it either, so
      pull it from your browser's dev tools (Application/Storage → Cookies →
      `tidymap_uid`, or the `Set-Cookie` header on the callback response in
      the Network tab) and use it as `YOUR_USER_ID` below.

- [ ] 2. Start an extraction:

      ```bash
      curl -X POST http://localhost:3000/extractions \
        -H 'content-type: application/json' \
        -d '{"userId":"YOUR_USER_ID"}'
      ```

      (Endpoints that need identity accept this body `userId` as a fallback
      to the session cookie — see "Using the web UI" above — so this curl
      workflow keeps working exactly as before; only how you obtain
      `YOUR_USER_ID` in step 1 has changed.)

- [ ] 3. Poll until `status` is `complete` — the archive typically takes a few minutes:

      ```bash
      curl http://localhost:3000/extractions/JOB_ID
      ```

- [ ] 4. Fetch the results:

      ```bash
      curl 'http://localhost:3000/extractions/JOB_ID/results?groupBy=category'
      curl 'http://localhost:3000/extractions/JOB_ID/results?groupBy=city'
      curl 'http://localhost:3000/extractions/JOB_ID/results?groupBy=country'
      ```

While running this, record the following — they are real gaps/behaviors this
codebase cannot self-verify without a live account, and are worth capturing
in the commit or PR that records the live run:

- **Archive job duration** — wall-clock time from step 2 to `status: complete`
  in step 3. The pipeline polls with exponential backoff (2s, 4s, 8s, ... capped
  at 30s) up to a 15-minute timeout, so this also tells you whether the timeout
  has comfortable margin.
- **How many of the up-to-20 items resolved** — compare `totalPlaces` against
  `unresolvedCount` in any of the three results responses (both fields are
  present regardless of `groupBy`). An item with `"resolved": false` still
  appears in the output; it is never silently dropped.
- **Which `primaryType` values are taxonomy gaps** — do **not** find these by
  grouping on `category` and reading the `Unknown` bucket; Phase 2 made that
  bucket the wrong place to look. An unmapped `primaryType` with a rescuable
  secondary type resolves to a real category (the `types[]` rescue — see
  "Categorization" above), and an unmapped `primaryType` with *no* rescuable
  secondary type now gets its own readable-type group instead of landing in
  `Unknown` ("Sub-category fallback grouping", also above). Only a place
  with no `primaryType` at all still reaches
  the literal `Unknown` bucket. Read `GET /extractions/JOB_ID`'s nullable
  `warnings` field instead — it reports every `primaryType` that reached
  neither a direct match nor a secondary-type rescue (alongside any export
  file that could not be parsed), which is the actual gap list. Each name in
  there is worth adding to the taxonomy table (`src/categorize/taxonomy.ts`).
- **Whether saved-collection items without coordinates resolved to the right
  city** — saved-collection rows carry no lat/lng (only starred places do;
  see `src/parse/saved-collections.ts` vs `src/parse/starred-places.ts`), so
  their Places match relies entirely on text search over title + address.
  Spot-check a few `city` values in the `groupBy=city` output against where
  you actually saved them.

If `GET /extractions/JOB_ID` reports `status: "failed"` with an `error`
mentioning `RESOURCE_EXHAUSTED`, see "Re-running an extraction" below — it
means a prior authorization is still on file.

## Re-running an extraction

Portability authorization is `ACCESS_TYPE_ONE_TIME`. A second extraction
attempt against the same authorization surfaces as a *failed* extraction, not
an HTTP error response: `POST /extractions` runs the pipeline in the
background and always returns `202` at once (poll for the outcome), so a
spent authorization cannot come back as a synchronous error from that call.
Instead, poll `GET /extractions/JOB_ID` until `status` is `"failed"`, and read
the guidance in its `error` field — it names both possible causes (Google
returns `RESOURCE_EXHAUSTED` for both a spent one-time authorization and
ordinary rate limiting) and spells out the next step. (The server also maps a
`RESOURCE_EXHAUSTED` error to a `409` in its central error handler, but no
route wired up today can actually reach that path with this error — it
documents the intent for a future synchronous call site, not current
behavior.)

To reset:

```bash
curl -X POST http://localhost:3000/auth/reset \
  -H 'content-type: application/json' \
  -d '{"userId":"YOUR_USER_ID"}'
```

Then re-authorize at `/auth/google` — the reset invalidates the existing
tokens, so consent must be repeated. Re-authorizing mints a **new** `userId`
(see "Cost of anonymity" above) — the old one still exists as a `users` row,
but it has no valid tokens and cannot be used for another extraction. The
callback sets the new `userId` as the session cookie (see "Using the web
UI" above), so the browser picks it up automatically; for curl, pull the new
value from dev tools the same way as in step 1 of the end-to-end checklist
— don't reuse the one you just reset.

**Warning:** Google returns `RESOURCE_EXHAUSTED` for both a spent one-time
authorization *and* ordinary rate limiting — the two cases are
indistinguishable from the response alone. `POST /auth/reset` is destructive:
it invalidates the token even if it was still valid. If you have **not** just
run an extraction and still see this failure, wait and retry before
resetting — only reset once you're confident the authorization really has
been spent.

If an archive job itself fails, `GET /extractions/:jobId` reports
`status: "failed"` or `status: "timed_out"` with only that status — Google's
`archiveJobs` response carries no free-text failure reason for `FAILED` or
`CANCELLED` states, so there is nothing more specific to surface.

### "Incremental auth is not allowed for the requested scopes"

If `/auth/google` fails with `Error 400: invalid_request` and this message, the
prior authorization is **still live on your Google account**. Per Google's
[troubleshooting guide][tsg], the error fires when "the end user has already
granted some scopes to the project, or the user has already granted some of the
requested scopes." Data Portability refuses to re-grant scopes you already hold,
and `prompt=consent` does not override it. (This app never sends
`include_granted_scopes`, so that documented cause does not apply here.)

The grant must be cleared before consent can succeed again. Two ways:

**Google-side revoke — always works, no app state required:**

1. Open <https://myaccount.google.com/permissions>
2. Select this app, then **Remove access**
3. Retry `/auth/google`

**In-app** — `POST /auth/reset` with the `userId` whose tokens hold the grant,
as above. This is the intended path, but it needs that user's stored tokens to
still be usable.

> **The trap.** Every consent mints a new `userId`, and `/auth/reset` needs the
> tokens of the user that holds the *live* grant. If a run fails and you lose
> track of which `userId` that was — or its tokens are already invalid — the app
> cannot reset the authorization for you, and consent will keep failing with the
> incremental-auth error. The Google-side revoke is the only guaranteed escape.
> The callback no longer prints the `userId` for you to note down — it's only
> in the session cookie now — so if you're relying on the in-app reset path,
> capture it from dev tools (see step 1 above) before starting an extraction.

[tsg]: https://developers.google.com/data-portability/user-guide/troubleshooting

## Tests

```bash
npm test
```

Every test runs offline. No test calls Google.
