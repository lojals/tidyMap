import { unzipSync, strFromU8 } from 'fflate';
import { basename } from 'node:path';
import type { ExportFile } from '../domain/types.js';

/** Local file header magic for a PKZIP archive. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function nameFromUrl(url: string): string {
  try {
    return decodeURIComponent(basename(new URL(url).pathname)) || 'export';
  } catch {
    return 'export';
  }
}

/**
 * Fetches every signed URL and returns the unpacked text files.
 *
 * Google may hand back either a zip or individual objects depending on the
 * export, so both are handled by sniffing the PKZIP magic bytes rather than
 * trusting the URL or content type.
 *
 * Every response is buffered fully into memory via arrayBuffer(). That is
 * fine for the MVP's ~20-item exports; a much larger export or archive would
 * need streaming instead.
 */
export async function downloadArchive(
  urls: string[],
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<ExportFile[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const files: ExportFile[] = [];

  for (const url of urls) {
    const response = await doFetch(url);
    if (!response.ok) {
      throw new Error(`Archive download failed with ${response.status} for ${url}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (isZip(bytes)) {
      const entries = unzipSync(bytes);
      for (const [path, content] of Object.entries(entries)) {
        if (path.endsWith('/')) continue;
        files.push({ path, content: strFromU8(content) });
      }
    } else {
      files.push({ path: nameFromUrl(url), content: strFromU8(bytes) });
    }
  }

  return files;
}
