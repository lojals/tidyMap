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
`drizzle-kit` migration step and nothing else to run first).

## Security posture (Phase 1)

The server binds `127.0.0.1` only — it is not reachable from other machines
on the network, even if your firewall would otherwise allow it. This is
deliberate, not incidental: `POST /auth/reset` is unauthenticated, and
`userId` is derived predictably from the Google account's `sub` claim
(`user_<sub>`), so the loopback binding is Phase 1's only access control.
Do not change the bind host without adding real authentication first.

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
verification (which has been run — see below) exercises the same code path
end-to-end minus the Portability API itself.

- [ ] 1. Open http://localhost:3000/auth/google and grant consent. The callback
      returns your `userId`.

- [ ] 2. Start an extraction:

      ```bash
      curl -X POST http://localhost:3000/extractions \
        -H 'content-type: application/json' \
        -d '{"userId":"YOUR_USER_ID"}'
      ```

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
- **Which `primaryType` values landed in `Unknown`** — group by `category`,
  look at the `Unknown` bucket, and read each place's `primaryType` field.
  Each one is a gap in the taxonomy table (`src/categorize/taxonomy.ts`)
  worth filling. `GET /extractions/JOB_ID` also reports these directly, in
  its nullable `warnings` field, alongside any export file that could not be
  parsed — no need to hunt through the grouped results by hand.
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
tokens, so consent must be repeated.

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

## Tests

```bash
npm test
```

Every test runs offline. No test calls Google.
