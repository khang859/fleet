import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';
import { getFileExtension, MEDIA_MIME_TYPES } from '../shared/file-open';

export type ByteRange =
  | { kind: 'full' }
  /** `end` is inclusive, as it is in the header. */
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * What a `Range` header asks for out of a file of `size` bytes. A header this
 * does not understand - another unit, several ranges, bad syntax - is ignored
 * and the whole file served, which RFC 9110 allows and a player copes with.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || size === 0) return { kind: 'full' };
  const [, first, last] = match;

  if (first === '') {
    // `-n` is the last n bytes.
    if (last === '') return { kind: 'full' };
    const suffix = Number(last);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return { kind: 'full' };
  return { kind: 'partial', start, end };
}

/**
 * Answer a `fleet-media://` request for `filePath`, which the caller has
 * already normalised. Streams from disk rather than through `net.fetch`: that
 * drops the `Range` header, and without a 206 a player cannot seek. Node
 * `fs` also reads the WSL UNC share, so there is no second path for it.
 */
export async function serveMedia(filePath: string, rangeHeader: string | null): Promise<Response> {
  const contentType = MEDIA_MIME_TYPES[getFileExtension(filePath)];
  if (!contentType) return new Response('Forbidden', { status: 403 });

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return new Response('Not Found', { status: 404 });
  const size = info.size;

  const range = parseByteRange(rangeHeader, size);
  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  const headers = new Headers({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
  if (size === 0) {
    headers.set('Content-Length', '0');
    return new Response(null, { headers });
  }

  const start = range.kind === 'partial' ? range.start : 0;
  const end = range.kind === 'partial' ? range.end : size - 1;
  headers.set('Content-Length', String(end - start + 1));
  if (range.kind === 'partial') headers.set('Content-Range', `bytes ${start}-${end}/${size}`);

  // A seek cancels the response it replaces; cancelling the web stream destroys
  // the file stream under it, so no descriptor outlives its request.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Node's web stream is the DOM one at runtime; only the two declarations differ
  const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
  return new Response(body, { status: range.kind === 'partial' ? 206 : 200, headers });
}
