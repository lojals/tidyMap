import { describe, it, expect } from 'vitest';
import { extractCity, extractCountry, type AddressComponent } from './address.js';

const c = (longText: string, shortText: string, ...types: string[]): AddressComponent =>
  ({ longText, shortText, types });

describe('extractCity', () => {
  it('uses locality when present (US)', () => {
    expect(extractCity([
      c('San Francisco', 'SF', 'locality', 'political'),
      c('California', 'CA', 'administrative_area_level_1'),
    ])).toBe('San Francisco');
  });

  it('falls back to postal_town when locality is absent (UK)', () => {
    expect(extractCity([
      c('London', 'London', 'postal_town'),
      c('Greater London', 'Greater London', 'administrative_area_level_2'),
    ])).toBe('London');
  });

  it('falls back to administrative_area_level_2 when both are absent', () => {
    expect(extractCity([
      c('Girona', 'Girona', 'administrative_area_level_2'),
    ])).toBe('Girona');
  });

  it('prefers locality over postal_town when both exist', () => {
    expect(extractCity([
      c('Brighton', 'Brighton', 'postal_town'),
      c('Hove', 'Hove', 'locality'),
    ])).toBe('Hove');
  });

  it('uses locality for Japan, not administrative_area_level_1', () => {
    expect(extractCity([
      c('Shibuya City', 'Shibuya', 'locality'),
      c('Tokyo', 'Tokyo', 'administrative_area_level_1'),
    ])).toBe('Shibuya City');
  });

  it('never falls back to administrative_area_level_1', () => {
    // Load-bearing. Every other fixture that carries administrative_area_level_1
    // also carries locality, so appending it to CITY_TYPES would pass every
    // other test in this file. This is the only case that would fail.
    expect(extractCity([
      c('Tokyo', 'Tokyo', 'administrative_area_level_1'),
      c('Japan', 'JP', 'country'),
    ])).toBeNull();
  });

  it('returns null when no city-like component exists', () => {
    expect(extractCity([c('Spain', 'ES', 'country')])).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractCity(undefined)).toBeNull();
  });

  it('does not throw and skips a component missing `types` entirely', () => {
    // The Places response is cast with `as` and never validated at runtime,
    // so a component can genuinely arrive without a `types` array.
    expect(extractCity([
      { longText: 'Mystery', shortText: 'Mystery' } as AddressComponent,
      c('Girona', 'Girona', 'administrative_area_level_2'),
    ])).toBe('Girona');
  });

  it('skips a component whose types match but which lacks longText, continuing the fallback chain', () => {
    expect(extractCity([
      { shortText: 'SF', types: ['locality'] } as AddressComponent,
      c('Fallback City', 'FC', 'administrative_area_level_2'),
    ])).toBe('Fallback City');
  });

  it('returns null, not undefined, when the only matching component lacks longText', () => {
    expect(extractCity([
      { shortText: 'SF', types: ['locality'] } as AddressComponent,
    ])).toBeNull();
  });
});

describe('extractCountry', () => {
  it('returns long name and ISO short code', () => {
    expect(extractCountry([c('Spain', 'ES', 'country', 'political')]))
      .toEqual({ name: 'Spain', code: 'ES' });
  });

  it('returns null when there is no country component', () => {
    expect(extractCountry([c('Barcelona', 'Barcelona', 'locality')])).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractCountry(undefined)).toBeNull();
  });

  it('does not throw and returns null for a component missing `types` entirely', () => {
    expect(extractCountry([
      { longText: 'Mystery', shortText: 'Mystery' } as AddressComponent,
    ])).toBeNull();
  });

  it('skips a country component that lacks longText, returning null rather than a name of undefined', () => {
    expect(extractCountry([
      { shortText: 'ES', types: ['country'] } as AddressComponent,
    ])).toBeNull();
  });
});
