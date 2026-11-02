import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileRange } from '../file-range';

describe('readFileRange', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-range-'));
    file = join(dir, 'data.bin');
    await writeFile(file, '0123456789');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the bytes from begin to end', async () => {
    expect((await readFileRange(file, 2, 5)).toString()).toBe('234');
  });

  it('cuts a range that goes past the end of the file', async () => {
    expect((await readFileRange(file, 8, 100)).toString()).toBe('89');
  });

  it('returns no bytes for a range that starts past the end', async () => {
    expect(await readFileRange(file, 20, 30)).toHaveLength(0);
  });

  it.each([
    [-1, 5],
    [5, 2],
    [0.5, 2],
    [0, Number.MAX_VALUE]
  ])('rejects the invalid range %s-%s', async (begin, end) => {
    await expect(readFileRange(file, begin, end)).rejects.toThrow('Invalid byte range');
  });

  it('rejects a missing file', async () => {
    await expect(readFileRange(join(dir, 'missing.bin'), 0, 1)).rejects.toThrow();
  });
});
