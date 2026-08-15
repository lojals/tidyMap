import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseStarredPlacesGeoJson } from './starred-places.js';

const json = readFileSync('fixtures/starred-places/Starred places.json', 'utf8');

describe('parseStarredPlacesGeoJson', () => {
  it('reads GeoJSON coordinates as [longitude, latitude]', () => {
    const [first] = parseStarredPlacesGeoJson(json);
    expect(first!.lng).toBe(2.1769);
    expect(first!.lat).toBe(41.3825);
  });

  it('reads name and address from the nested location object', () => {
    const [first] = parseStarredPlacesGeoJson(json);
    expect(first!.title).toBe("Satan's Coffee Corner");
    expect(first!.address).toContain('Sant Ramon del Call');
  });

  it('falls back to flat name and address properties', () => {
    const items = parseStarredPlacesGeoJson(json);
    expect(items[1]!.title).toBe('Time Out Market');
    expect(items[1]!.address).toContain('24 de Julho');
  });

  it('labels every item with the Starred places source list', () => {
    for (const item of parseStarredPlacesGeoJson(json)) {
      expect(item.sourceList).toBe('Starred places');
    }
  });

  it('skips features with no resolvable name', () => {
    const bare = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
    });
    expect(parseStarredPlacesGeoJson(bare)).toEqual([]);
  });

  it('returns an empty array when features is missing', () => {
    expect(parseStarredPlacesGeoJson('{"type":"FeatureCollection"}')).toEqual([]);
  });
});
