import { parse } from 'csv-parse/sync';
import type { SavedItem } from '../domain/types.js';

/** Header names differ between the Portability schema and legacy Takeout exports. */
const FIELD_ALIASES: Record<string, string[]> = {
  title: ['title'],
  note: ['note'],
  url: ['item_content_url', 'url'],
  comment: ['comment'],
};

function pick(row: Record<string, string>, field: keyof typeof FIELD_ALIASES): string {
  for (const alias of FIELD_ALIASES[field]!) {
    const value = row[alias];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function isMapsPlaceUrl(url: string): boolean {
  if (!url) return false;
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'maps.app.goo.gl' || hostname === 'goo.gl') return true;
    if (!hostname.endsWith('google.com')) return false;
    return pathname.startsWith('/maps/');
  } catch {
    return false;
  }
}

/**
 * Parses one saved-collection CSV. Collections can contain shopping products,
 * images, searches and arbitrary web pages alongside places — everything that
 * is not a Maps place URL is dropped here.
 */
export function parseSavedCollectionsCsv(csv: string, listName: string): SavedItem[] {
  const rows = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  return rows.flatMap((row, index) => {
    const url = pick(row, 'url');
    if (!isMapsPlaceUrl(url)) return [];

    const note = pick(row, 'note') || pick(row, 'comment');
    return [{
      sourceId: `collection:${listName}:${index}`,
      title: pick(row, 'title'),
      mapsUrl: url,
      ...(note ? { note } : {}),
      sourceList: listName,
    }];
  });
}
