import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportFile } from '../domain/types.js';

const FIXTURE_DIRS = ['fixtures/starred-places', 'fixtures/saved-collections'];

/**
 * Reads the committed sample export instead of calling Google.
 *
 * This exists because Portability authorization is one-time-use: every real
 * run costs a browser consent round-trip, which makes iterating on parsing
 * or grouping logic against live data impractical.
 */
export function loadFixtureExport(): ExportFile[] {
  return FIXTURE_DIRS.flatMap((dir) =>
    readdirSync(dir).map((name) => ({
      path: join(dir, name),
      content: readFileSync(join(dir, name), 'utf8'),
    })),
  );
}
