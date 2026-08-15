import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { loadFixtureExport } from './fixture-source.js';

describe('loadFixtureExport', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it('loads fixtures from every configured directory', () => {
    const files = loadFixtureExport();
    expect(files.some((f) => f.path.includes('starred-places'))).toBe(true);
    expect(files.some((f) => f.path.includes('saved-collections'))).toBe(true);
  });

  it('does not depend on process.cwd() to find fixtures/', () => {
    // Before this fix, loadFixtureExport joined 'fixtures/...' against the
    // caller's working directory, so `node dist/server.js` launched from
    // anywhere other than the repo root would throw ENOENT. Chdir'ing to a
    // directory with no fixtures/ of its own proves resolution is now
    // anchored to this module's own file location instead.
    process.chdir(tmpdir());
    expect(() => loadFixtureExport()).not.toThrow();
    expect(loadFixtureExport().length).toBeGreaterThan(0);
  });
});
