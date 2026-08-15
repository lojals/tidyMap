import { basename, extname } from 'node:path';
import type { ExportFile, SavedItem } from '../domain/types.js';
import { parseSavedCollectionsCsv } from './saved-collections.js';
import { parseStarredPlacesGeoJson } from './starred-places.js';

const skipped = new Map<string, string>();

/** Files that threw during parsing, keyed by path, with the parser's message. */
export function skippedFiles(): ReadonlyMap<string, string> {
  return skipped;
}

export function resetSkippedFiles(): void {
  skipped.clear();
}

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

    // One malformed file must not cost the user every other list.
    try {
      if (ext === '.json') {
        starred.push(...parseStarredPlacesGeoJson(file.content));
      } else if (ext === '.csv') {
        collections.push({ listName, items: parseSavedCollectionsCsv(file.content, listName) });
      }
    } catch (error) {
      skipped.set(file.path, error instanceof Error ? error.message : String(error));
    }
  }

  collections.sort((a, b) => a.listName.localeCompare(b.listName));

  return [...starred, ...collections.flatMap((c) => c.items)].slice(0, limit);
}
