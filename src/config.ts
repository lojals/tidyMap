import { z } from 'zod';

const schema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_PLACES_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  PORTABILITY_SOURCE: z.enum(['live', 'fixture']).default('live'),
  PORT: z.coerce.number().default(3000),
  EXTRACTION_LIMIT: z.coerce.number().int().positive().default(20),
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
