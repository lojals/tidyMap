import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSavedCollectionsCsv } from './saved-collections.js';

const csv = readFileSync('fixtures/saved-collections/Want to go.csv', 'utf8');

describe('parseSavedCollectionsCsv', () => {
  it('keeps only Google Maps place URLs', () => {
    const items = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(items.map((i) => i.title)).toEqual([
      "Satan's Coffee Corner", 'Bar Cañete', 'Park Güell',
    ]);
  });

  it('carries note, mapsUrl, and sourceList through', () => {
    const [first] = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(first!.note).toBe('cortado');
    expect(first!.sourceList).toBe('Want to go');
    expect(first!.mapsUrl).toContain('/maps/place/');
  });

  it('produces no coordinates — collections CSV has none', () => {
    const [first] = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(first!.lat).toBeUndefined();
    expect(first!.lng).toBeUndefined();
  });

  it('accepts the legacy Takeout header casing', () => {
    const legacy = 'Title,Note,URL,Comment\nTupinamba,,https://www.google.com/maps/place/Tupinamba/,\n';
    const items = parseSavedCollectionsCsv(legacy, 'Favorites');
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Tupinamba');
  });

  it('returns an empty array for a header-only file', () => {
    expect(parseSavedCollectionsCsv('title,note,item_content_url\n', 'Empty')).toEqual([]);
  });

  it('assigns stable sourceIds derived from list name and row index', () => {
    const items = parseSavedCollectionsCsv(csv, 'Want to go');
    expect(items[0]!.sourceId).toBe('collection:Want to go:0');
  });
});
