import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseByteRange, serveMedia } from '../media-protocol';

describe('parseByteRange', () => {
  it('serves the whole file when there is no usable range', () => {
    for (const header of [
      null,
      'items=0-1',
      'bytes=0-1,5-6',
      'bytes=abc',
      'bytes=-',
      'bytes=5-2'
    ]) {
      expect(parseByteRange(header, 100)).toEqual({ kind: 'full' });
    }
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'full' });
  });

  it('reads an open and a closed range', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ kind: 'partial', start: 10, end: 19 });
  });

  it('clamps an end past the file', () => {
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
  });

  it('reads a suffix as the last bytes', () => {
    expect(parseByteRange('bytes=-5', 100)).toEqual({ kind: 'partial', start: 95, end: 99 });
    expect(parseByteRange('bytes=-9999', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
  });

  it('rejects a start at or past the end', () => {
    expect(parseByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('serveMedia', () => {
  let dir: string;
  let video: string;
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-media-'));
    video = join(dir, 'clip.mp4');
    writeFileSync(video, bytes);
    writeFileSync(join(dir, 'empty.webm'), '');
    writeFileSync(join(dir, 'notes.txt'), 'secret');
    mkdirSync(join(dir, 'folder.mp4'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('serves the whole file without a range', async () => {
    const res = await serveMedia(video, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('serves exactly the bytes a range asks for', async () => {
    const res = await serveMedia(video, 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(10, 20));
  });

  it('answers 416 with the file size for a range past the end', async () => {
    const res = await serveMedia(video, 'bytes=500-');
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */100');
  });

  it('serves an empty file as an empty body', async () => {
    const res = await serveMedia(join(dir, 'empty.webm'), 'bytes=0-');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/webm');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('serves audio under its own type', async () => {
    writeFileSync(join(dir, 'song.mp3'), bytes);
    const res = await serveMedia(join(dir, 'song.mp3'), 'bytes=0-0');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('refuses a file that is not media', async () => {
    expect((await serveMedia(join(dir, 'notes.txt'), null)).status).toBe(403);
  });

  it('answers 404 for a missing file and for a directory', async () => {
    expect((await serveMedia(join(dir, 'gone.mp4'), null)).status).toBe(404);
    expect((await serveMedia(join(dir, 'folder.mp4'), null)).status).toBe(404);
  });
});
