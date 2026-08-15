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

  it('returns null when no city-like component exists', () => {
    expect(extractCity([c('Spain', 'ES', 'country')])).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractCity(undefined)).toBeNull();
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
});
