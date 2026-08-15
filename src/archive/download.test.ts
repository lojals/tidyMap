import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8, strFromU8 } from 'fflate';
import { downloadArchive } from './download.js';

const bin = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes, { status: 200 });

describe('downloadArchive', () => {
  it('unzips a zip response into its member files', async () => {
    const zip = zipSync({
      'Saved/Want to go.csv': strToU8('title\nA\n'),
      'Maps/Starred places.json': strToU8('{}'),
    });
    const fetch = vi.fn().mockResolvedValue(bin(zip));

    const files = await downloadArchive(['https://signed'], { fetch: fetch as never });

    expect(files.map((f) => f.path).sort())
      .toEqual(['Maps/Starred places.json', 'Saved/Want to go.csv']);
    expect(files.find((f) => f.path.endsWith('.csv'))!.content).toBe('title\nA\n');
  });

  it('treats a non-zip response as a single file named from the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(bin(strToU8('title\nA\n')));
    const files = await downloadArchive(
      ['https://storage.googleapis.com/bucket/Want%20to%20go.csv?sig=x'],
      { fetch: fetch as never },
    );
    expect(files).toEqual([{ path: 'Want to go.csv', content: 'title\nA\n' }]);
  });

  it('falls back to "export" when the URL has no usable basename', async () => {
    const fetch = vi.fn().mockResolvedValue(bin(strToU8('title\nA\n')));
    const files = await downloadArchive(
      ['https://storage.googleapis.com'],
      { fetch: fetch as never },
    );
    expect(files).toEqual([{ path: 'export', content: 'title\nA\n' }]);
  });

  it('concatenates results across multiple signed URLs', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(bin(strToU8('a')))
      .mockResolvedValueOnce(bin(strToU8('b')));
    const files = await downloadArchive(
      ['https://host/one.csv', 'https://host/two.csv'],
      { fetch: fetch as never },
    );
    expect(files).toHaveLength(2);
  });

  it('skips zip directory entries', async () => {
    const zip = zipSync({ 'Saved/': strToU8(''), 'Saved/x.csv': strToU8('title\n') });
    const fetch = vi.fn().mockResolvedValue(bin(zip));
    const files = await downloadArchive(['https://signed'], { fetch: fetch as never });
    expect(files.map((f) => f.path)).toEqual(['Saved/x.csv']);
  });

  it('does not classify a "PK" prefix that is not a local-file-header as a zip', async () => {
    // 0x50 0x4b is the PKZIP prefix shared by several record types (local
    // file header, central directory header, end-of-central-directory).
    // Only 0x03 0x04 (local file header) marks the payload itself as a zip;
    // this body deliberately differs in bytes 2-3 so it must fall through
    // to the single-file path, not be handed to unzipSync.
    const bytes = new Uint8Array([0x50, 0x4b, 0x00, 0x00, 0x41]);
    const fetch = vi.fn().mockResolvedValue(bin(bytes));
    const files = await downloadArchive(['https://host/data.bin'], { fetch: fetch as never });
    expect(files).toEqual([{ path: 'data.bin', content: strFromU8(bytes) }]);
  });

  it('throws when a signed URL fails, naming both the status and the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
    await expect(downloadArchive(['https://signed/foo'], { fetch: fetch as never }))
      .rejects.toThrow('Archive download failed with 404 for https://signed/foo');
  });
});
