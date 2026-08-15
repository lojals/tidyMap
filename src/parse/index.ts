import { basename, extname } from 'node:path';
import type { ExportFile, SavedItem } from '../domain/types.js';
import { parseSavedCollectionsCsv } from './saved-collections.js';
import { parseStarredPlacesGeoJson } from './starred-places.js';

/**
 * Merges every file in an unpacked export into one ordered list, then applies
 * the cap. Order is deterministic — starred places first, then collections
 * alphabetically by list name — so "the first 20" means the same thing on
 * every run regardless of how the archive happened to unzip.
 */
export function parseExport(files: ExportFile[], limit: number): SavedItem[] {
  const starred: SavedItem[] = [];
  const collections: { listName: string; items: SavedItem[] }[] = [];

  for (const file of files) {
    const ext = extname(file.path).toLowerCase();
    const listName = basename(file.path, extname(file.path));

    if (ext === '.json') {
      starred.push(...parseStarredPlacesGeoJson(file.content));
    } else if (ext === '.csv') {
      collections.push({ listName, items: parseSavedCollectionsCsv(file.content, listName) });
    }
  }

  collections.sort((a, b) => a.listName.localeCompare(b.listName));

  return [...starred, ...collections.flatMap((c) => c.items)].slice(0, limit);
}
