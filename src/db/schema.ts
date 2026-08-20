import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';

// Portability-only consent is anonymous: Google's Data Portability scopes
// cannot be requested alongside `openid`/`email` (Google rejects the mixed
// scope request outright), so the OAuth flow never receives an id_token and
// there is no `sub` or `email` claim to store. `id` is an opaque randomUUID()
// minted in src/auth/oauth.ts's persistTokens, not derived from anything
// Google returns.
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
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
  /**
   * Non-fatal issues recorded during parse/enrich: files that could not be
   * parsed (per-file, never aborts the whole extraction) and Places
   * primaryType values with no taxonomy mapping. Null when there were none.
   */
  warnings: text('warnings'),
  /**
   * Current pipeline stage: requesting | preparing | downloading | reading |
   * resolving | organizing. Null once the job reaches a terminal status
   * (complete | failed | timed_out) -- the UI reads `status` for those, and
   * a stale stage would be misleading.
   */
  stage: text('stage'),
  /** Free-text detail for stages that have one, e.g. '12 of 20' during resolving. */
  stageDetail: text('stage_detail'),
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

export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  createdAt: integer('created_at').notNull(),
});
