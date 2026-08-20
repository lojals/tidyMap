import { describe, it, expect } from 'vitest';
import { sessionCookieOptions } from './identity.js';

describe('sessionCookieOptions', () => {
  // @fastify/cookie defaults sameSite to 'lax' itself when the options object
  // omits the field (see Object.assign({ sameSite: 'lax' }, options) in its
  // setCookie wrapper), so an integration test asserting on the resulting
  // Set-Cookie header cannot tell "we set sameSite: 'lax'" apart from "we
  // set nothing and the library's default happened to match." Asserting on
  // the object this function returns pins our own code instead of a library
  // default that could change out from under us.
  it('sets httpOnly and sameSite=lax explicitly, not by relying on library defaults', () => {
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('sets Path=/ and a 30-day Max-Age', () => {
    const options = sessionCookieOptions();
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it('omits secure, since the server is plain http on 127.0.0.1', () => {
    const options = sessionCookieOptions() as Record<string, unknown>;
    expect(options.secure).toBeUndefined();
  });
});
