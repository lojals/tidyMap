import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_PLACES_API_KEY: 'places-key',
  DATABASE_URL: './tidymap.db',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);
    expect(config.google.clientId).toBe('id');
    expect(config.placesApiKey).toBe('places-key');
    expect(config.port).toBe(3000);
    expect(config.portabilitySource).toBe('live');
  });

  it('defaults extraction limit to 20', () => {
    expect(loadConfig(valid).extractionLimit).toBe(20);
  });

  it('accepts fixture as a portability source', () => {
    expect(loadConfig({ ...valid, PORTABILITY_SOURCE: 'fixture' }).portabilitySource).toBe('fixture');
  });

  it('rejects an unknown portability source', () => {
    expect(() => loadConfig({ ...valid, PORTABILITY_SOURCE: 'maybe' })).toThrow();
  });

  it('fails fast with a readable message when the Places key is missing', () => {
    const { GOOGLE_PLACES_API_KEY: _omitted, ...withoutKey } = valid;
    expect(() => loadConfig(withoutKey)).toThrow(/GOOGLE_PLACES_API_KEY/);
  });
});
