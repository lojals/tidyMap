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
