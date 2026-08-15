import { describe, it, expect } from 'vitest';
import { parseExport } from './index.js';

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
    expect(parseExport([{ path: 'Saved/photo.jpg', content: 'binary' }], 20)).toEqual([]);
  });
});
