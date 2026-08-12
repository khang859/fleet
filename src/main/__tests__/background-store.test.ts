import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { adoptBackgroundImage } from '../background-store';

describe('adoptBackgroundImage', () => {
  let dir: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-bg-src-'));
    dest = join(dir, 'backgrounds');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the picture in and answers with where it went', async () => {
    const source = join(dir, 'a.png');
    await writeFile(source, 'pretend png');

    const result = adoptBackgroundImage(source, dest);

    expect(result.success).toBe(true);
    expect(await readdir(dest)).toHaveLength(1);
  });

  it('stores the same picture once, however many times it is adopted', async () => {
    const first = join(dir, 'a.png');
    const second = join(dir, 'copy-of-a.png');
    await writeFile(first, 'identical bytes');
    await writeFile(second, 'identical bytes');

    const one = adoptBackgroundImage(first, dest);
    const two = adoptBackgroundImage(second, dest);

    expect(one).toEqual(two);
    expect(await readdir(dest)).toHaveLength(1);
  });

  it('gives different pictures different names', async () => {
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    await writeFile(a, 'one');
    await writeFile(b, 'two');

    adoptBackgroundImage(a, dest);
    adoptBackgroundImage(b, dest);

    expect(await readdir(dest)).toHaveLength(2);
  });

  it('keeps the extension, so the copy is still recognisably an image', async () => {
    const source = join(dir, 'a.WEBP');
    await writeFile(source, 'bytes');

    const result = adoptBackgroundImage(source, dest);

    expect(result.success && result.path.endsWith('.webp')).toBe(true);
  });

  it('refuses a file type the slideshow scanner would skip', async () => {
    const source = join(dir, 'a.svg');
    await writeFile(source, '<svg/>');

    expect(adoptBackgroundImage(source, dest)).toEqual({
      success: false,
      error: '.svg cannot be used as a background'
    });
  });

  it('refuses something that is not an image at all', async () => {
    const source = join(dir, 'notes.txt');
    await writeFile(source, 'hello');

    expect(adoptBackgroundImage(source, dest).success).toBe(false);
  });

  it('fails rather than throws when the picture is already gone', () => {
    const result = adoptBackgroundImage(join(dir, 'missing.png'), dest);

    expect(result.success).toBe(false);
  });
});
