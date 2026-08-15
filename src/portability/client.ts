const BASE = 'https://dataportability.googleapis.com/v1';

/**
 * Resource names for portabilityArchive:initiate. These are the OAuth scope
 * suffixes — the quickstart shows {"resources":["myactivity.search"]}.
 */
export const PORTABILITY_RESOURCES = ['saved.collections', 'maps.starred_places'] as const;

export const PORTABILITY_SCOPES = PORTABILITY_RESOURCES.map(
  (resource) => `https://www.googleapis.com/auth/dataportability.${resource}`,
);

export type ArchiveState = 'IN_PROGRESS' | 'COMPLETE' | 'FAILED' | 'CANCELLED';

export interface PortabilityDeps {
  fetch?: typeof globalThis.fetch;
}

/**
 * Raised on a 403 carrying RESOURCE_EXHAUSTED.
 *
 * That status is ambiguous: Google uses it both for a spent one-time
 * authorization AND for ordinary quota/rate limiting. The remedies conflict —
 * authorization:reset invalidates the current token, so "just reset it" is
 * destructive when the real cause was a rate limit. The message therefore
 * states both possibilities instead of asserting the likelier one.
 */
export class ConsentAlreadyUsedError extends Error {
  constructor() {
    super(
      'Google returned RESOURCE_EXHAUSTED. This usually means the one-time ' +
      'Portability authorization has already been spent, but Google returns the ' +
      'same status for quota and rate limiting. If you have not just run an ' +
      'extraction, wait and retry before resetting — POST /auth/reset invalidates ' +
      'the current token, which is destructive if it was still valid. If the ' +
      'authorization really is spent: POST /auth/reset, then re-authorize at ' +
      'GET /auth/google.',
    );
    this.name = 'ConsentAlreadyUsedError';
  }
}

async function call(
  url: string,
  accessToken: string,
  deps: PortabilityDeps,
  body?: unknown,
): Promise<Response> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  return doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function initiateArchive(
  accessToken: string,
  deps: PortabilityDeps = {},
): Promise<{ archiveJobId: string; accessType: string }> {
  const response = await call(`${BASE}/portabilityArchive:initiate`, accessToken, deps, {
    resources: [...PORTABILITY_RESOURCES],
  });

  if (response.status === 403) {
    const text = await response.text();
    if (text.includes('RESOURCE_EXHAUSTED')) throw new ConsentAlreadyUsedError();
    throw new Error(`Portability initiate failed with 403: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Portability initiate failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as { archiveJobId: string; accessType: string };
}

export async function getArchiveState(
  accessToken: string,
  jobId: string,
  deps: PortabilityDeps = {},
): Promise<{ state: ArchiveState; urls: string[] }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(`${BASE}/archiveJobs/${jobId}/portabilityArchiveState`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Portability state check failed with ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as { state: ArchiveState; urls?: string[] };
  return { state: json.state, urls: json.urls ?? [] };
}

export async function resetAuthorization(
  accessToken: string,
  deps: PortabilityDeps = {},
): Promise<void> {
  const response = await call(`${BASE}/authorization:reset`, accessToken, deps);
  if (!response.ok) {
    throw new Error(`Authorization reset failed with ${response.status}: ${await response.text()}`);
  }
}
