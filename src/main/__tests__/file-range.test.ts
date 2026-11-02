import { mkdtemp, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileRange, type FileVersion } from '../file-range';

describe('readFileRange', () => {
  let dir: string;
  let file: string;
  let version: FileVersion;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-range-'));
    file = join(dir, 'data.bin');
    await writeFile(file, '0123456789');
    const st = await stat(file);
    version = { size: st.size, modifiedAt: st.mtimeMs };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the bytes from begin to end', async () => {
    expect((await readFileRange(file, 2, 5, version))?.toString()).toBe('234');
  });

  it('cuts a range that goes past the end of the file', async () => {
    expect((await readFileRange(file, 8, 100, version))?.toString()).toBe('89');
  });

  it('returns no bytes for a range that starts past the end', async () => {
    expect(await readFileRange(file, 20, 30, version)).toHaveLength(0);
  });

  it.each([
    [-1, 5],
    [5, 2],
    [0.5, 2],
    [0, Number.MAX_VALUE]
  ])('rejects the invalid range %s-%s', async (begin, end) => {
    await expect(readFileRange(file, begin, end, version)).rejects.toThrow('Invalid byte range');
  });

  it('returns null when the file is gone', async () => {
    await rm(file);
    expect(await readFileRange(file, 0, 1, version)).toBeNull();
  });

  it('returns null when the file has a new size', async () => {
    await writeFile(file, '0123456789abc');
    expect(await readFileRange(file, 0, 1, version)).toBeNull();
  });

  it('returns null when the file has the same size but a new change time', async () => {
    await writeFile(file, 'abcdefghij');
    const later = new Date(version.modifiedAt + 5000);
    await utimes(file, later, later);
    expect(await readFileRange(file, 0, 1, version)).toBeNull();
  });
});
