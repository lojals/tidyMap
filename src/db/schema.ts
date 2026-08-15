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

export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  createdAt: integer('created_at').notNull(),
});
