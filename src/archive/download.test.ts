import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
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

  it('throws when a signed URL fails', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
    await expect(downloadArchive(['https://signed'], { fetch: fetch as never }))
      .rejects.toThrow(/404/);
  });
});
