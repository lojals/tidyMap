import { unzipSync, strFromU8 } from 'fflate';
import { basename } from 'node:path';
import type { ExportFile } from '../domain/types.js';

/** Local file header magic for a PKZIP archive. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Strips query parameters from a URL for safe use in logs/errors. Signed
 * Cloud Storage URLs carry X-Goog-Signature / X-Goog-Credential in the query
 * string -- a bearer capability for the user's entire Maps export -- so only
 * origin+pathname may ever be surfaced. Falls back to the raw string if the
 * URL cannot be parsed, rather than throwing a second error while already
 * handling one.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * Names a single (non-zip) file from its signed URL's path. Assumes Cloud
 * Storage object URLs always carry a real basename; if that assumption ever
 * fails, this falls back to the literal string 'export'. A file named
 * 'export' has no .csv/.json extension, so parseExport silently ignores it
 * and it won't even appear in skippedFiles() — a genuine place-bearing file
 * could be dropped with no diagnostic. Accepted as unlikely given how signed
 * Cloud Storage URLs are shaped, not because the risk is zero.
 */
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
      // This message propagates into extractions.error (persisted in SQLite)
      // and is served by GET /extractions/:jobId, so the raw signed URL --
      // whose query string carries the actual bearer capability -- must
      // never appear in it. Only origin+pathname is safe to surface.
      throw new Error(`Archive download failed with ${response.status} for ${redactUrl(url)}`);
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
