import { describe, it, expect } from 'vitest';
import { parseExport, skippedFiles, resetSkippedFiles } from './index.js';

const starred = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ geometry: { coordinates: [2, 41] }, properties: { name: 'Starred One' } }],
});
const csvB = 'title,item_content_url\nB List Place,https://www.google.com/maps/place/B/\n';
const csvA = 'title,item_content_url\nA List Place,https://www.google.com/maps/place/A/\n';

describe('parseExport', () => {
  it('orders starred places first, then collections alphabetically by list', () => {
    const items = parseExport([
      { path: 'Saved/B list.csv', content: csvB },
      { path: 'Saved/A list.csv', content: csvA },
      { path: 'Maps/Starred places.json', content: starred },
    ], 20);
    expect(items.map((i) => i.title)).toEqual(['Starred One', 'A List Place', 'B List Place']);
  });

  it('derives the list name from the file basename', () => {
    const items = parseExport([{ path: 'Saved/A list.csv', content: csvA }], 20);
    expect(items[0]!.sourceList).toBe('A list');
  });

  it('applies the cap after ordering', () => {
    const items = parseExport([
      { path: 'Saved/B list.csv', content: csvB },
      { path: 'Maps/Starred places.json', content: starred },
    ], 1);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Starred One');
  });

  it('ignores files that are neither .csv nor .json', () => {
    // Content that WOULD yield an item if extension routing were removed.
    // A bare 'binary' string parses to [] under the CSV parser anyway, so it
    // could not distinguish "skipped by extension" from "empty by coincidence".
    const csvLike = 'title,item_content_url\nDecoy,https://www.google.com/maps/place/Decoy/\n';
    expect(parseExport([{ path: 'Saved/photo.jpg', content: csvLike }], 20)).toEqual([]);
  });

  it('skips an unparseable file and still parses the rest', () => {
    resetSkippedFiles();
    const items = parseExport([
      { path: 'Maps/Starred places.json', content: '{ not json at all' },
      { path: 'Saved/A list.csv', content: csvA },
    ], 20);
    expect(items.map((i) => i.title)).toEqual(['A List Place']);
  });

  it('records the skipped file rather than swallowing the error', () => {
    resetSkippedFiles();
    parseExport([{ path: 'Maps/Starred places.json', content: '{ not json at all' }], 20);
    expect([...skippedFiles().keys()]).toEqual(['Maps/Starred places.json']);
    expect(skippedFiles().get('Maps/Starred places.json')).toBeTruthy();
  });
});
