# TidyMap Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser UI that drives the extraction flow end to end, show categories with emojis, and make unmapped places useful instead of collapsing them into one `Unknown` bucket.

**Architecture:** Four small backend changes (categorization rescue via `types[]`, emoji + sub-category fallback in grouping, a cookie session, `GET /extractions`) plus a static page served by Fastify from `public/`. No build step: the page is plain HTML/CSS/JS, with its decision logic in a pure module that Vitest imports directly.

**Tech Stack:** Node 22 LTS, TypeScript 5.9 (ESM), Fastify 5, `@fastify/cookie`, `@fastify/static`, Drizzle + better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-tidymap-phase2-design.md`

## Global Constraints

- **ESM only.** All relative imports in `src/` MUST carry a `.js` extension even though the source is `.ts`. TypeScript does not rewrite these.
- **Node 22 LTS minimum.**
- **No build step for the UI.** `public/` is served as-is. Do not introduce a bundler, JSX, or TypeScript under `public/`.
- **`logger: false` on Fastify is security-relevant, not a preference.** The OAuth authorization code arrives as a query parameter; default request logging would write it to stdout. Do not enable logging.
- **The server binds `127.0.0.1`.** Do not change the bind host.
- **Cookie attributes are load-bearing.** `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days, no `Secure` (the server is plain http on loopback). `SameSite=Lax` is what stops a cross-site POST to the unauthenticated, destructive `/auth/reset`.
- **Never drop a saved place.** Unresolved places are kept with `resolved: false`.
- **Stage only the files your task touches.** Verify `git status --short` before committing.
- Every task ends with a commit.

## Prove your tests are load-bearing

Phase 1 shipped a test that passed regardless of the behavior it named in **all twelve tasks** — reviewers caught it every time. Each task below names specific mutations. For each: break the behavior, confirm a test FAILS, restore, confirm it passes. Report the actual output. If breaking it does NOT produce a failure, the test is hollow — strengthen it and say so.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/categorize/taxonomy.ts` | *Modify.* `types[]` rescue; category→emoji table |
| `src/domain/types.ts` | *Modify.* `ResolvedPlace.types`; `PlaceGroup.emoji` |
| `src/enrich/index.ts` | *Modify.* Retain `types[]`, pass it to `categorize` |
| `src/group/index.ts` | *Modify.* Sub-category fallback key; emoji per group |
| `src/auth/identity.ts` | *Create.* Read identity from cookie, falling back to body |
| `src/auth/routes.ts` | *Modify.* Callback sets cookie + redirects; reset uses identity |
| `src/jobs/routes.ts` | *Modify.* `POST /extractions` uses identity; add `GET /extractions` |
| `src/server.ts` | *Modify.* Register cookie + static plugins |
| `public/app-state.js` | *Create.* Pure UI decision logic. No DOM, no fetch |
| `public/app.js` | *Create.* DOM wiring, fetch, polling |
| `public/index.html` | *Create.* Markup for all five states |
| `public/style.css` | *Create.* Minimal styling |

---

## Task 1: Categorization rescue via `types[]`

**Files:**
- Modify: `src/categorize/taxonomy.ts`, `src/domain/types.ts`, `src/enrich/index.ts`
- Test: `src/categorize/taxonomy.test.ts`, `src/enrich/index.test.ts`

**Interfaces:**
- Consumes: `Category` from `src/domain/types.js`
- Produces: `categorize(primaryType: string | null | undefined, types?: readonly string[] | null): Category`; `ResolvedPlace.types: string[]`

**Background.** The Places field mask already requests `places.types`; Phase 1 discarded it. A place typed `yak_rental, tourist_attraction, point_of_interest` currently lands in `Unknown` even though `tourist_attraction` maps to `Culture`.

- [ ] **Step 1: Write the failing tests**

Add to `src/categorize/taxonomy.test.ts`:

```ts
  it('rescues an unmapped primaryType using a mappable secondary type', () => {
    expect(categorize('yak_rental', ['yak_rental', 'tourist_attraction', 'point_of_interest']))
      .toBe('Culture');
  });

  it('prefers primaryType over any secondary type', () => {
    expect(categorize('cafe', ['cafe', 'tourist_attraction'])).toBe('Food & Drink');
  });

  it('uses the FIRST mappable secondary type, not the last', () => {
    expect(categorize('yak_rental', ['museum', 'park'])).toBe('Culture');
  });

  it('returns Unknown when neither primaryType nor any secondary type maps', () => {
    expect(categorize('yak_rental', ['yak_rental', 'point_of_interest'])).toBe('Unknown');
  });

  it('applies the *_restaurant suffix rule to secondary types too', () => {
    expect(categorize('yak_rental', ['sushi_restaurant'])).toBe('Food & Drink');
  });

  it('counts the primaryType, not a rescued secondary type', () => {
    resetUnmappedCounts();
    categorize('yak_rental', ['tourist_attraction']);
    // Rescued: the place got a real category, so it is not a taxonomy gap.
    expect(unmappedTypeCounts().size).toBe(0);
  });

  it('counts the primaryType when nothing rescues it', () => {
    resetUnmappedCounts();
    categorize('yak_rental', ['point_of_interest']);
    expect([...unmappedTypeCounts().keys()]).toEqual(['yak_rental']);
  });

  it('tolerates a missing types argument (old persisted payloads)', () => {
    expect(categorize('cafe')).toBe('Food & Drink');
    expect(categorize('yak_rental')).toBe('Unknown');
    expect(categorize(null)).toBe('Unknown');
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/categorize/taxonomy.test.ts`
Expected: FAIL — `categorize` takes one argument, so the rescue cases return `Unknown`.

- [ ] **Step 3: Rewrite `categorize` in `src/categorize/taxonomy.ts`**

Replace the existing `categorize` with:

```ts
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
```

- [ ] **Step 4: Add `types` to `ResolvedPlace` in `src/domain/types.ts`**

Add the field directly after `primaryType`:

```ts
  primaryType: string | null;
  /**
   * Raw Places `types[]`. May be absent on places persisted before Phase 2 --
   * `places.payload` is a JSON column, so old rows were never migrated. Treat
   * it as possibly undefined when reading stored payloads.
   */
  types: string[];
```

- [ ] **Step 5: Retain and use `types` in `src/enrich/index.ts`**

In `toResolvedPlace`, the unresolved branch gains `types: []` after `primaryType: null`. The resolved branch changes two lines:

```ts
    category: categorize(match.primaryType, match.types),
    primaryType: match.primaryType ?? null,
    types: match.types ?? [],
```

- [ ] **Step 6: Add the enrich-level test**

Add to `src/enrich/index.test.ts`:

```ts
  it('rescues a place whose primaryType is unmapped but whose types[] maps', async () => {
    const rescued = () => new Response(JSON.stringify({
      places: [{
        id: 'ChIJrescue',
        displayName: { text: 'Odd Museum' },
        primaryType: 'yak_rental',
        types: ['yak_rental', 'museum'],
        addressComponents: [{ longText: 'Spain', shortText: 'ES', types: ['country'] }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const fetch = vi.fn().mockImplementation(async () => rescued());
    const [place] = await enrich([item({})], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(place!.category).toBe('Culture');
    expect(place!.primaryType).toBe('yak_rental');
    expect(place!.types).toEqual(['yak_rental', 'museum']);
  });

  it('stores an empty types array when Google returns none', async () => {
    const noTypes = () => new Response(JSON.stringify({
      places: [{ id: 'ChIJbare', displayName: { text: 'Bare' }, primaryType: 'cafe' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const fetch = vi.fn().mockImplementation(async () => noTypes());
    const [place] = await enrich([item({})], { apiKey: 'K', fetch: fetch as never, sleep: noSleep });

    expect(place!.types).toEqual([]);
    expect(place!.category).toBe('Food & Drink');
  });
```

Note `mockImplementation`, not `mockResolvedValue`: a `Response` body can only be read once, and reusing one instance across calls fails. This bit Phase 1 three times.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass, typecheck clean.

- [ ] **Step 8: Mutation checks**

1. Delete the `for (const type of types ?? [])` loop → the rescue tests must fail.
2. Move the `unmapped.set(...)` above the rescue loop → "counts the primaryType, not a rescued secondary" must fail.
3. Change the loop to iterate in reverse → "uses the FIRST mappable secondary type" must fail.

Restore all three. Report the actual output for each.

- [ ] **Step 9: Commit**

```bash
git add src/categorize/taxonomy.ts src/categorize/taxonomy.test.ts src/domain/types.ts src/enrich/index.ts src/enrich/index.test.ts
git commit -m "feat: rescue unmapped places using the Places types array"
```

---

## Task 2: Emoji and sub-category fallback in grouping

**Files:**
- Modify: `src/categorize/taxonomy.ts`, `src/domain/types.ts`, `src/group/index.ts`
- Test: `src/categorize/taxonomy.test.ts`, `src/group/index.test.ts`

**Interfaces:**
- Consumes: `categorize` from Task 1; `Category`, `GroupBy`, `ResolvedPlace`
- Produces: `emojiForCategory(category: Category): string`; `FALLBACK_EMOJI`, `CITY_EMOJI`, `COUNTRY_EMOJI` constants; `PlaceGroup.emoji: string`

- [ ] **Step 1: Write the failing emoji test**

Add to `src/categorize/taxonomy.test.ts`:

```ts
describe('emojiForCategory', () => {
  it('returns a distinct emoji for every category', () => {
    const categories: Category[] = [
      'Food & Drink', 'Nightlife', 'Lodging', 'Shopping', 'Outdoors',
      'Culture', 'Entertainment', 'Services', 'Transport', 'Unknown',
    ];
    const emojis = categories.map(emojiForCategory);
    expect(emojis.every((e) => e.length > 0)).toBe(true);
    // Distinct so a glance at the UI actually distinguishes groups.
    expect(new Set(emojis).size).toBe(categories.length);
  });
});
```

Add `import type { Category } from '../domain/types.js';` if not already present, and add `emojiForCategory` to the existing import from `./taxonomy.js`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/categorize/taxonomy.test.ts`
Expected: FAIL — `emojiForCategory` is not exported.

- [ ] **Step 3: Add the emoji table to `src/categorize/taxonomy.ts`**

```ts
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
```

`Unknown` gets `❓` and non-category fallback groups get `📌`; they are different states and should not look identical.

- [ ] **Step 4: Add `emoji` to `PlaceGroup` in `src/domain/types.ts`**

```ts
export type PlaceGroup = {
  [key: string]: string | ResolvedPlace[];
  emoji: string;
  places: ResolvedPlace[];
};
```

The existing index signature already permits `string`, so this narrows rather than conflicts.

- [ ] **Step 5: Write the failing grouping tests**

Add to `src/group/index.test.ts`:

```ts
  it('groups an uncategorized place under its readable primaryType', () => {
    const result = group(
      [place({ category: 'Unknown', primaryType: 'yak_rental' })],
      'category',
    );
    expect(result.results[0]!['category']).toBe('Yak Rental');
  });

  it('keeps Unknown for a place with no primaryType at all', () => {
    const result = group(
      [place({ category: 'Unknown', primaryType: null, resolved: false })],
      'category',
    );
    expect(result.results[0]!['category']).toBe('Unknown');
  });

  it('does not merge two different unmapped types into one group', () => {
    const result = group([
      place({ category: 'Unknown', primaryType: 'yak_rental' }),
      place({ category: 'Unknown', primaryType: 'art_studio' }),
    ], 'category');
    expect(result.results.map((g) => g['category']).sort()).toEqual(['Art Studio', 'Yak Rental']);
  });

  it('gives curated categories their own emoji and fallbacks the neutral one', () => {
    const result = group([
      place({ category: 'Food & Drink' }),
      place({ category: 'Unknown', primaryType: 'yak_rental' }),
    ], 'category');
    const byKey = Object.fromEntries(result.results.map((g) => [g['category'], g['emoji']]));
    expect(byKey['Food & Drink']).toBe('🍽️');
    expect(byKey['Yak Rental']).toBe('📌');
  });

  it('groups a pre-Phase-2 payload that has no types field', () => {
    // places.payload is a JSON column, so rows written before Task 1 have no
    // `types`. Grouping reads category and primaryType only, and must not
    // start assuming the newer shape.
    const legacy = { ...place({ category: 'Unknown', primaryType: 'yak_rental' }) };
    delete (legacy as { types?: unknown }).types;

    const result = group([legacy], 'category');
    expect(result.results[0]!['category']).toBe('Yak Rental');
  });

  it('gives city and country groups their dimension emoji', () => {
    expect(group([place({ city: 'Lisbon' })], 'city').results[0]!['emoji']).toBe('🏙️');
    expect(group([place({ country: 'Spain' })], 'country').results[0]!['emoji']).toBe('🌍');
  });
```

Update the `place()` helper in that file so its defaults include `types: []` and `primaryType: 'cafe'` if they do not already.

- [ ] **Step 6: Run them and confirm they fail**

Run: `npx vitest run src/group/index.test.ts`
Expected: FAIL — unmapped places all key to `Unknown`, and `emoji` is undefined.

- [ ] **Step 7: Implement in `src/group/index.ts`**

```ts
import {
  emojiForCategory, FALLBACK_EMOJI, CITY_EMOJI, COUNTRY_EMOJI,
} from '../categorize/taxonomy.js';
import type { Category, GroupBy, GroupedResult, PlaceGroup, ResolvedPlace } from '../domain/types.js';

const CURATED: ReadonlySet<string> = new Set<Category>([
  'Food & Drink', 'Nightlife', 'Lodging', 'Shopping', 'Outdoors',
  'Culture', 'Entertainment', 'Services', 'Transport', 'Unknown',
]);

/** `yak_rental` -> `Yak Rental`. */
function readableType(type: string): string {
  return type
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function keyFor(place: ResolvedPlace, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'category':
      // A place Google typed but our table does not cover becomes its own
      // group rather than joining one useless Unknown pile. Places with no
      // type at all have nothing better to say and stay Unknown.
      if (place.category !== 'Unknown') return place.category;
      return place.primaryType ? readableType(place.primaryType) : 'Unknown';
    case 'city': return place.city ?? 'Unknown';
    case 'country': return place.country ?? 'Unknown';
  }
}

function emojiFor(key: string, groupBy: GroupBy): string {
  if (groupBy === 'city') return CITY_EMOJI;
  if (groupBy === 'country') return COUNTRY_EMOJI;
  return CURATED.has(key) ? emojiForCategory(key as Category) : FALLBACK_EMOJI;
}
```

Then in `group()`, change the `.map(...)` that builds results to:

```ts
    .map(([key, bucketPlaces]) => ({
      [groupBy]: key,
      emoji: emojiFor(key, groupBy),
      places: bucketPlaces,
    }));
```

Leave the sort untouched. Fallback groups are small, so descending-count ordering already sinks them below the curated categories.

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass, typecheck clean.

- [ ] **Step 9: Mutation checks**

1. Make `keyFor`'s category branch always return `place.category` → the three fallback tests must fail.
2. Make `emojiFor` always return `FALLBACK_EMOJI` → the curated-emoji test must fail.
3. Make `readableType` return the raw type → "readable primaryType" must fail.

Restore all three. Report the actual output.

- [ ] **Step 10: Commit**

```bash
git add src/categorize/taxonomy.ts src/categorize/taxonomy.test.ts src/domain/types.ts src/group/index.ts src/group/index.test.ts
git commit -m "feat: add group emojis and sub-category fallback grouping"
```

---

## Task 3: Cookie session

**Files:**
- Create: `src/auth/identity.ts`
- Modify: `src/server.ts`, `src/auth/routes.ts`, `src/jobs/routes.ts`
- Test: `src/auth/routes.test.ts`, `src/jobs/routes.test.ts`

**Interfaces:**
- Consumes: `persistTokens` from `src/auth/oauth.js`
- Produces: `SESSION_COOKIE = 'tidymap_uid'`; `identityFrom(request: FastifyRequest): string | undefined`; `sessionCookieOptions()`

- [ ] **Step 1: Install the cookie plugin**

```bash
npm install @fastify/cookie
```

- [ ] **Step 2: Create `src/auth/identity.ts`**

```ts
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'tidymap_uid';

/**
 * 30 days. Consent is one-time-use and expensive to repeat, so a session
 * cookie that dies with the browser would be actively hostile.
 */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Cookie attributes. Every one of these is load-bearing:
 *
 * - httpOnly: page scripts cannot read the id.
 * - sameSite 'lax': THE security control here. `/auth/reset` is
 *   unauthenticated and destructive (it revokes the Portability grant). Once a
 *   cookie supplies identity automatically, the unguessable userId stops
 *   protecting that route, and any page in the browser could POST to
 *   localhost. 'lax' withholds the cookie on cross-site POSTs.
 * - secure omitted: the server is plain http on 127.0.0.1.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

/**
 * Identity for a request: the session cookie, falling back to a body
 * `userId` so the curl workflows documented in the README keep working.
 * The cookie wins when both are present.
 */
export function identityFrom(request: FastifyRequest): string | undefined {
  const fromCookie = request.cookies?.[SESSION_COOKIE];
  if (fromCookie) return fromCookie;

  const body = request.body as { userId?: unknown } | undefined;
  return typeof body?.userId === 'string' && body.userId ? body.userId : undefined;
}
```

- [ ] **Step 3: Register the plugin in `src/server.ts`**

Add the import and register it before the route plugins:

```ts
import cookie from '@fastify/cookie';
```

```ts
  app.register(cookie);
  app.register(async (instance) => authRoutes(instance, ctx));
```

- [ ] **Step 4: Write the failing callback test**

Add to `src/auth/routes.test.ts`:

```ts
  it('sets a session cookie and redirects to / instead of returning JSON', async () => {
    const { app, db } = buildTestServer();
    const state = createAuthState(db);

    const response = await app.inject({
      method: 'GET', url: `/auth/google/callback?code=abc&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('tidymap_uid=');
    expect(setCookie).toContain('HttpOnly');
    // SameSite=Lax is what stops a cross-site POST to the unauthenticated,
    // destructive /auth/reset once a cookie carries identity.
    expect(setCookie).toContain('SameSite=Lax');
  });
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run src/auth/routes.test.ts`
Expected: FAIL — the callback returns 200 with a JSON body.

- [ ] **Step 6: Change the callback in `src/auth/routes.ts`**

Replace the final `return reply.send({ userId, next: ... })` with:

```ts
      // Redirect rather than render JSON: after consent the browser lands
      // here, and the user should end up in the app. The opaque userId stays
      // in an HttpOnly cookie so it never reaches the URL or browser history.
      return reply
        .setCookie(SESSION_COOKIE, userId, sessionCookieOptions())
        .redirect('/', 302);
```

Add the import:

```ts
import { SESSION_COOKIE, identityFrom, sessionCookieOptions } from './identity.js';
```

And change `/auth/reset` to use the shared helper:

```ts
  app.post<{ Body: { userId?: string } }>('/auth/reset', async (request, reply) => {
    const userId = identityFrom(request);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
```

- [ ] **Step 7: Write the failing identity tests**

Add to `src/jobs/routes.test.ts`:

```ts
  it('accepts identity from the session cookie with no body userId', async () => {
    const { app } = buildTestServer();
    const created = await app.inject({
      method: 'POST', url: '/extractions',
      cookies: { tidymap_uid: 'u1' },
      payload: {},
    });
    expect(created.statusCode).toBe(202);
  });

  it('prefers the cookie over a body userId when both are present', async () => {
    const { app, db } = buildTestServer();
    db.insert(users).values({ id: 'u2', createdAt: 0 }).run();

    const created = await app.inject({
      method: 'POST', url: '/extractions',
      cookies: { tidymap_uid: 'u1' },
      payload: { userId: 'u2' },
    });

    const { jobId } = created.json<{ jobId: string }>();
    const row = db.select().from(extractions).where(eq(extractions.id, jobId)).all()[0]!;
    expect(row.userId).toBe('u1');
  });
```

- [ ] **Step 8: Run them and confirm they fail**

Run: `npx vitest run src/jobs/routes.test.ts`
Expected: FAIL — `POST /extractions` reads only `request.body.userId`.

- [ ] **Step 9: Use `identityFrom` in `src/jobs/routes.ts`**

```ts
import { identityFrom } from '../auth/identity.js';
```

```ts
  app.post<{ Body: { userId?: string } }>('/extractions', async (request, reply) => {
    const userId = identityFrom(request);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
```

The rest of the handler is unchanged.

- [ ] **Step 10: Run the full suite**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass. Existing body-identity tests must still pass — the fallback is deliberate.

- [ ] **Step 11: Mutation checks**

1. Remove `sameSite` from `sessionCookieOptions()` → the SameSite assertion must fail.
2. Remove `httpOnly` → the HttpOnly assertion must fail.
3. Reverse the precedence in `identityFrom` (body first) → "prefers the cookie" must fail.

Restore all three. Report the actual output.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json src/auth/identity.ts src/auth/routes.ts src/auth/routes.test.ts src/jobs/routes.ts src/jobs/routes.test.ts src/server.ts
git commit -m "feat: hold identity in an HttpOnly SameSite=Lax session cookie"
```

---

## Task 4: `GET /extractions`

**Files:**
- Modify: `src/jobs/routes.ts`
- Test: `src/jobs/routes.test.ts`

**Interfaces:**
- Consumes: `identityFrom` from `src/auth/identity.js`
- Produces: `GET /extractions` → `{ extractions: Array<{ jobId, status, createdAt }> }`, newest first; `401` when unidentified

**Background.** Archive jobs take minutes. Without this the UI must stash the `jobId` in `localStorage`, and closing the tab orphans a running job.

- [ ] **Step 1: Write the failing tests**

```ts
  it('lists the caller extractions newest first', async () => {
    const { app, db } = buildTestServer();
    db.insert(extractions).values([
      { id: 'old', userId: 'u1', status: 'complete', createdAt: 1000, updatedAt: 1000 },
      { id: 'new', userId: 'u1', status: 'running', createdAt: 2000, updatedAt: 2000 },
    ]).run();

    const response = await app.inject({
      method: 'GET', url: '/extractions', cookies: { tidymap_uid: 'u1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ extractions: { jobId: string }[] }>().extractions.map((e) => e.jobId))
      .toEqual(['new', 'old']);
  });

  it('returns 401 when there is no identity, which the UI reads as signed out', async () => {
    const { app } = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/extractions' });
    expect(response.statusCode).toBe(401);
  });

  it('never lists another user extractions', async () => {
    const { app, db } = buildTestServer();
    db.insert(users).values({ id: 'other', createdAt: 0 }).run();
    db.insert(extractions).values([
      { id: 'mine', userId: 'u1', status: 'complete', createdAt: 1, updatedAt: 1 },
      { id: 'theirs', userId: 'other', status: 'complete', createdAt: 2, updatedAt: 2 },
    ]).run();

    const response = await app.inject({
      method: 'GET', url: '/extractions', cookies: { tidymap_uid: 'u1' },
    });
    expect(response.json<{ extractions: { jobId: string }[] }>().extractions.map((e) => e.jobId))
      .toEqual(['mine']);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/jobs/routes.test.ts`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Add the route in `src/jobs/routes.ts`**

Register it **before** `/extractions/:jobId` for readability (Fastify's radix router distinguishes them regardless):

```ts
  app.get('/extractions', async (request, reply) => {
    const userId = identityFrom(request);
    if (!userId) return reply.code(401).send({ error: 'Not signed in.' });

    const rows = ctx.db.select().from(extractions)
      .where(eq(extractions.userId, userId)).all();

    return reply.send({
      extractions: rows
        .map((row) => ({ jobId: row.id, status: row.status, createdAt: row.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt),
    });
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Mutation checks**

1. Drop the `.where(eq(extractions.userId, userId))` → "never lists another user extractions" must fail.
2. Reverse the sort → "newest first" must fail.
3. Return `200` with an empty list instead of `401` → the 401 test must fail.

Restore all three. Report the actual output.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/routes.ts src/jobs/routes.test.ts
git commit -m "feat: add GET /extractions so the UI can resume a running job"
```

---

## Task 5: Static serving and the pure UI state module

**Files:**
- Create: `public/app-state.js`, `public/app-state.test.js`, `public/index.html` (placeholder)
- Modify: `src/server.ts`
- Test: `public/app-state.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `resolveView(input): 'signed-out' | 'ready' | 'running' | 'done' | 'failed'`; `formatElapsed(ms: number): string`; `pollDelayMs(elapsedMs: number): number`; `describeFailure(error: string | null): { message: string; ambiguous: boolean; showResetHelp: boolean }`

**Note.** `public/app-state.js` is plain JavaScript with JSDoc types — **not** TypeScript. Vitest picks up `public/app-state.test.js` through its default include glob. The test file is served as a static asset; that is harmless on a loopback single-user tool and keeps the module colocated with its test, matching the rest of the repo.

- [ ] **Step 1: Install the static plugin**

```bash
npm install @fastify/static
```

- [ ] **Step 2: Write the failing tests**

`public/app-state.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { resolveView, formatElapsed, pollDelayMs, describeFailure } from './app-state.js';

describe('resolveView', () => {
  it('is signed-out when the listing was unauthorized', () => {
    expect(resolveView({ authorized: false, extractions: [] })).toBe('signed-out');
  });

  it('is ready when signed in with no extractions', () => {
    expect(resolveView({ authorized: true, extractions: [] })).toBe('ready');
  });

  it('is running for a pending or running newest extraction', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'pending' }] })).toBe('running');
    expect(resolveView({ authorized: true, extractions: [{ status: 'running' }] })).toBe('running');
  });

  it('is done for a complete newest extraction', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'complete' }] })).toBe('done');
  });

  it('is failed for failed or timed_out', () => {
    expect(resolveView({ authorized: true, extractions: [{ status: 'failed' }] })).toBe('failed');
    expect(resolveView({ authorized: true, extractions: [{ status: 'timed_out' }] })).toBe('failed');
  });

  it('reads only the newest extraction, not older ones', () => {
    // The list arrives newest-first from GET /extractions.
    expect(resolveView({
      authorized: true,
      extractions: [{ status: 'running' }, { status: 'complete' }],
    })).toBe('running');
  });
});

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(5000)).toBe('5s');
  });

  it('shows minutes and seconds beyond a minute', () => {
    expect(formatElapsed(83_000)).toBe('1m 23s');
  });

  it('floors rather than rounds, so it never reads ahead of reality', () => {
    expect(formatElapsed(5999)).toBe('5s');
  });
});

describe('pollDelayMs', () => {
  it('polls briskly for the first minute', () => {
    expect(pollDelayMs(0)).toBe(3000);
    expect(pollDelayMs(59_000)).toBe(3000);
  });

  it('backs off after a minute, because archives take minutes', () => {
    expect(pollDelayMs(60_000)).toBe(10_000);
    expect(pollDelayMs(600_000)).toBe(10_000);
  });
});

describe('describeFailure', () => {
  it('flags RESOURCE_EXHAUSTED as ambiguous and does not urge a reset', () => {
    const result = describeFailure('Google returned RESOURCE_EXHAUSTED. ...');
    expect(result.ambiguous).toBe(true);
    // Resetting a still-valid token is destructive and irreversible, so the
    // UI must not present it as the obvious next step here.
    expect(result.showResetHelp).toBe(false);
  });

  it('offers reset help for an ordinary failure', () => {
    const result = describeFailure('enrich: something broke');
    expect(result.ambiguous).toBe(false);
    expect(result.showResetHelp).toBe(true);
  });

  it('tolerates a null error', () => {
    expect(describeFailure(null).message.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run public/app-state.test.js`
Expected: FAIL — cannot resolve `./app-state.js`.

- [ ] **Step 4: Write `public/app-state.js`**

```js
/**
 * Pure UI decision logic. No DOM, no fetch, no globals -- everything here is
 * a function of its arguments so it can be tested directly.
 */

/**
 * Which view the page should show.
 * @param {{ authorized: boolean, extractions: { status: string }[] }} input
 * @returns {'signed-out'|'ready'|'running'|'done'|'failed'}
 */
export function resolveView(input) {
  if (!input.authorized) return 'signed-out';

  const newest = input.extractions[0];
  if (!newest) return 'ready';

  if (newest.status === 'pending' || newest.status === 'running') return 'running';
  if (newest.status === 'complete') return 'done';
  return 'failed';
}

/**
 * Elapsed time, floored so it never claims more time has passed than has.
 * @param {number} ms
 */
export function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Poll briskly at first, then back off. Archive jobs take minutes, so a fixed
 * fast poll is wasted requests and a fixed slow one feels dead.
 * @param {number} elapsedMs
 */
export function pollDelayMs(elapsedMs) {
  return elapsedMs < 60_000 ? 3000 : 10_000;
}

/**
 * How to present a failed extraction.
 *
 * RESOURCE_EXHAUSTED is deliberately NOT treated as "go reset". Google returns
 * it for both a spent one-time authorization and ordinary rate limiting, and
 * `/auth/reset` destroys a token that may still be perfectly good.
 * @param {string|null} error
 */
export function describeFailure(error) {
  const message = error ?? 'The extraction failed without reporting a reason.';
  const ambiguous = message.includes('RESOURCE_EXHAUSTED');
  return { message, ambiguous, showResetHelp: !ambiguous };
}
```

- [ ] **Step 5: Run them and confirm they pass**

Run: `npx vitest run public/app-state.test.js`
Expected: PASS.

- [ ] **Step 6: Serve `public/` from `src/server.ts`**

```ts
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
```

Register before the route plugins:

```ts
  // Resolved from this module rather than process.cwd(): `npm start` runs
  // dist/server.js and may be launched from any directory. `src/` and `dist/`
  // are both one level below the repo root, so `..` reaches it either way.
  const here = dirname(fileURLToPath(import.meta.url));
  app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/' });
```

- [ ] **Step 7: Verify the page is served**

Create a placeholder `public/index.html` containing just `ok`, then:

```bash
npx tsx src/server.ts &
```

Wait a moment, then `curl -s http://localhost:3000/` — expect `ok`. Stop the server. Task 6 replaces the placeholder.

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 9: Mutation checks**

1. Make `resolveView` read `extractions[extractions.length - 1]` → "reads only the newest" must fail.
2. Make `pollDelayMs` always return 3000 → the back-off test must fail.
3. Make `describeFailure` always set `showResetHelp: true` → the RESOURCE_EXHAUSTED test must fail.

Restore all three. Report the actual output.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json public/app-state.js public/app-state.test.js public/index.html src/server.ts
git commit -m "feat: serve public/ and add the pure UI state module"
```

---

## Task 6: The page

**Files:**
- Create: `public/style.css`, `public/app.js`
- Modify: `public/index.html` (replace the placeholder)

**Interfaces:**
- Consumes: `resolveView`, `formatElapsed`, `pollDelayMs`, `describeFailure` from `./app-state.js`; the HTTP API from Tasks 3–4
- Produces: no exports — this is the entry point

**Note.** `app.js` is loaded as `<script type="module">` so it can import `app-state.js`. Keep it thin: every decision belongs in `app-state.js`, where it is tested.

- [ ] **Step 1: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TidyMap</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header><h1>TidyMap</h1></header>

  <main>
    <section id="view-signed-out" hidden>
      <p>Organize your saved Google Maps places by category, city, or country.</p>
      <a class="button" href="/auth/google">Connect Google</a>
    </section>

    <section id="view-ready" hidden>
      <p>Ready to extract your saved places.</p>
      <p class="note">
        This takes a few minutes and spends a one-time Google authorization.
        Running it again later requires clearing the grant first.
      </p>
      <button class="button" id="start">Extract my saved places</button>
    </section>

    <section id="view-running" hidden>
      <p>Google is building your archive. <span id="elapsed"></span></p>
      <p class="note" id="running-status"></p>
    </section>

    <section id="view-done" hidden>
      <div class="controls">
        <span>Group by</span>
        <button class="tab" data-group="category">Category</button>
        <button class="tab" data-group="city">City</button>
        <button class="tab" data-group="country">Country</button>
      </div>
      <p class="note" id="summary"></p>
      <div class="warnings" id="warnings" hidden>
        <button class="dismiss" id="dismiss-warnings" aria-label="Dismiss">&times;</button>
        <span id="warnings-text"></span>
      </div>
      <div id="groups"></div>
    </section>

    <section id="view-failed" hidden>
      <h2>That run failed</h2>
      <pre id="failure"></pre>
      <div id="failure-help"></div>
    </section>
  </main>

  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
:root { --fg: #1a1a1a; --muted: #666; --line: #e2e2e2; --bg: #fff; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 2rem 1.25rem; max-width: 46rem;
  font: 16px/1.55 system-ui, -apple-system, sans-serif;
  color: var(--fg); background: var(--bg);
}
h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
h2 { font-size: 1.1rem; }
.note { color: var(--muted); font-size: 0.9rem; }
.button {
  display: inline-block; padding: 0.6rem 1rem; border: 1px solid var(--fg);
  border-radius: 6px; background: var(--fg); color: #fff;
  font: inherit; cursor: pointer; text-decoration: none;
}
.button:disabled { opacity: 0.5; cursor: default; }
.controls { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; }
.tab {
  padding: 0.35rem 0.7rem; border: 1px solid var(--line); border-radius: 999px;
  background: none; font: inherit; cursor: pointer;
}
.tab[aria-selected="true"] { border-color: var(--fg); font-weight: 600; }
.group { border-top: 1px solid var(--line); padding: 1rem 0; }
.group h3 { margin: 0 0 0.5rem; font-size: 1rem; }
.group .count { color: var(--muted); font-weight: 400; }
.place { padding: 0.35rem 0; }
.place .addr { color: var(--muted); font-size: 0.85rem; }
.place .note-text { font-size: 0.85rem; font-style: italic; }
.warnings {
  position: relative; border: 1px solid var(--line); border-radius: 6px;
  padding: 0.75rem 2rem 0.75rem 0.75rem; margin-bottom: 1rem; font-size: 0.9rem;
}
.dismiss {
  position: absolute; top: 0.35rem; right: 0.5rem;
  border: none; background: none; font-size: 1.2rem; line-height: 1;
  cursor: pointer; color: var(--muted);
}
pre { white-space: pre-wrap; background: #f6f6f6; padding: 0.75rem; border-radius: 6px; }
```

- [ ] **Step 3: Write `public/app.js`**

```js
import { resolveView, formatElapsed, pollDelayMs, describeFailure } from './app-state.js';

const VIEWS = ['signed-out', 'ready', 'running', 'done', 'failed'];

let currentJobId = null;
let startedAt = 0;
let groupBy = 'category';
let pollTimer = null;

function show(view) {
  for (const name of VIEWS) {
    document.getElementById(`view-${name}`).hidden = name !== view;
  }
}

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
}

async function loadInitialState() {
  const listing = await getJson('/extractions');
  const view = resolveView({
    authorized: listing.ok,
    extractions: listing.body?.extractions ?? [],
  });

  const newest = listing.body?.extractions?.[0];
  if (newest) currentJobId = newest.jobId;

  if (view === 'running') {
    startedAt = Date.now();
    show('running');
    poll();
    return;
  }
  if (view === 'done') { await renderResults(); return; }
  if (view === 'failed') { await renderFailure(); return; }
  show(view);
}

async function start() {
  const button = document.getElementById('start');
  button.disabled = true;

  const response = await fetch('/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: '{}',
  });

  button.disabled = false;
  if (!response.ok) { show('signed-out'); return; }

  currentJobId = (await response.json()).jobId;
  startedAt = Date.now();
  show('running');
  poll();
}

async function poll() {
  const elapsed = Date.now() - startedAt;
  document.getElementById('elapsed').textContent = formatElapsed(elapsed);

  const status = await getJson(`/extractions/${currentJobId}`);
  const state = status.body?.status;
  document.getElementById('running-status').textContent = state ? `Status: ${state}` : '';

  if (state === 'complete') { await renderResults(); return; }
  if (state === 'failed' || state === 'timed_out') { await renderFailure(); return; }

  pollTimer = setTimeout(poll, pollDelayMs(elapsed));
}

async function renderFailure() {
  clearTimeout(pollTimer);
  const status = await getJson(`/extractions/${currentJobId}`);
  const { message, ambiguous, showResetHelp } = describeFailure(status.body?.error ?? null);

  document.getElementById('failure').textContent = message;
  document.getElementById('failure-help').innerHTML = ambiguous
    ? `<p class="note">Google returns this for both a spent authorization and ordinary
       rate limiting, and they are indistinguishable from the response. Resetting
       destroys a token that may still be valid &mdash; if you have not just run an
       extraction, wait and retry before resetting.</p>`
    : showResetHelp
      ? `<p class="note">To run again, clear the Portability grant at
         <a href="https://myaccount.google.com/permissions" target="_blank"
         rel="noopener">myaccount.google.com/permissions</a>, then
         <a href="/auth/google">reconnect</a>.</p>`
      : '';

  show('failed');
}

async function renderResults() {
  clearTimeout(pollTimer);

  const status = await getJson(`/extractions/${currentJobId}`);
  const results = await getJson(`/extractions/${currentJobId}/results?groupBy=${groupBy}`);
  if (!results.ok) { show('failed'); return; }

  const { totalPlaces, unresolvedCount, results: groups } = results.body;
  document.getElementById('summary').textContent =
    `${totalPlaces} places, ${groups.length} groups, ${unresolvedCount} unresolved`;

  document.getElementById('warnings-text').textContent = status.body?.warnings ?? '';
  document.getElementById('warnings').hidden = !status.body?.warnings;

  document.getElementById('groups').innerHTML = groups.map((groupItem) => {
    const key = groupItem[groupBy];
    const places = groupItem.places.map((place) => `
      <div class="place">
        <div>${escapeHtml(place.name)}</div>
        ${place.address ? `<div class="addr">${escapeHtml(place.address)}</div>` : ''}
        ${place.note ? `<div class="note-text">${escapeHtml(place.note)}</div>` : ''}
      </div>`).join('');

    return `<section class="group">
      <h3>${groupItem.emoji} ${escapeHtml(key)} <span class="count">${groupItem.places.length}</span></h3>
      ${places}
    </section>`;
  }).join('');

  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.group === groupBy));
  }

  show('done');
}

/**
 * Place names, addresses and notes are user data that arrived from Google --
 * never trust them as markup.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

document.getElementById('start').addEventListener('click', start);
document.getElementById('dismiss-warnings').addEventListener('click', () => {
  document.getElementById('warnings').hidden = true;
});
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => { groupBy = tab.dataset.group; renderResults(); });
}

loadInitialState();
```

- [ ] **Step 4: Verify the page loads**

Start the server with `npx tsx src/server.ts`, then confirm:
- `curl -s http://localhost:3000/` contains `Connect Google`
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/app-state.js` returns `200`

Stop the server.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass. `public/` is not in `tsconfig.json`'s `include`, so plain JS there is not typechecked.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat: add the browser UI for the extraction flow"
```

---

## Task 7: Documentation and fixture-mode verification

**Files:**
- Modify: `README.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Verify the flow in fixture mode**

Run the server with `PORTABILITY_SOURCE=fixture` against a scratch database. Fixture mode still requires a `users` row, and only OAuth creates one — seed a row and send its id as the `tidymap_uid` cookie.

Confirm, recording actual output:
1. `GET /` serves the page
2. `GET /extractions` with no cookie returns 401
3. `POST /extractions` with a cookie returns 202
4. `GET /extractions/:jobId/results?groupBy=category` includes `emoji` on every group
5. Any uncategorized place has a readable type as its group key, not `Unknown`

If no valid `GOOGLE_PLACES_API_KEY` is available, enrichment fails and every place comes back unresolved. **Report exactly how far you got and do not claim the flow passed.** An honest partial verification is the required outcome; a fabricated success is a serious failure.

- [ ] **Step 2: Update `README.md`**

Add a "Using the web UI" section: open `http://localhost:3000/`, click Connect Google, click Extract, the run takes minutes, results group by category/city/country. State that the UI is served from `public/` with no build step, and that curl workflows still work because the endpoints accept a body `userId` as well as the cookie.

- [ ] **Step 3: Update `docs/HANDOFF.md`**

Under state, record that Phase 2 shipped the UI, the cookie session, `GET /extractions`, emojis, and sub-category fallback — and whether a live run has happened since.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/HANDOFF.md
git commit -m "docs: cover the web UI and Phase 2 changes"
```

---

## Verification checklist

Before declaring Phase 2 complete, confirm each with actual command output:

- [ ] `npx vitest run` — all suites pass
- [ ] `npx tsc --noEmit` — no type errors
- [ ] Every group in a `groupBy=category` response carries an `emoji`
- [ ] An unmapped place with a `primaryType` groups under its readable type, not `Unknown`
- [ ] A place with a mappable secondary type is rescued into a real category
- [ ] The OAuth callback sets `HttpOnly` and `SameSite=Lax` and redirects to `/`
- [ ] `GET /extractions` returns 401 unidentified and never lists another user's rows
- [ ] The page renders all five states
- [ ] Existing curl workflows using a body `userId` still work
