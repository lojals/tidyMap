import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExportFile } from '../domain/types.js';

const FIXTURE_DIRS = ['fixtures/starred-places', 'fixtures/saved-collections'];

// Resolved relative to this file's own location, not process.cwd(): the
// previous plain 'fixtures/...' relative paths only worked when the process
// happened to be launched from the repo root (true for `npm run dev` /
// `vitest`, not guaranteed for `node dist/server.js` run from elsewhere).
// dist/ mirrors src/'s directory structure 1:1 (tsconfig rootDir: 'src',
// outDir: 'dist'), so the same '../..' climb from this file's own directory
// reaches the repo root whether this is src/jobs/fixture-source.ts or its
// compiled dist/jobs/fixture-source.js -- both are two levels below the repo
// root, where fixtures/ lives as a sibling of dist/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Reads the committed sample export instead of calling Google.
 *
 * This exists because Portability authorization is one-time-use: every real
 * run costs a browser consent round-trip, which makes iterating on parsing
 * or grouping logic against live data impractical.
 *
 * Only works when fixtures/ is actually present next to this module's build
 * output. `npm run build` (plain `tsc`) does not copy fixtures/ into dist/ --
 * it is not a .ts source file -- so fixture mode with a built server only
 * works when dist/ is run from within a checkout that still has fixtures/ at
 * its repo root (e.g. `node dist/server.js` from a clone of this repo). A
 * dist/ directory shipped on its own, without the rest of the repo, cannot
 * use fixture mode; see the README's "Running without Google" section.
 */
export function loadFixtureExport(): ExportFile[] {
  return FIXTURE_DIRS.flatMap((relativeDir) => {
    const absoluteDir = join(REPO_ROOT, relativeDir);
    return readdirSync(absoluteDir).map((name) => ({
      path: join(relativeDir, name),
      content: readFileSync(join(absoluteDir, name), 'utf8'),
    }));
  });
}
