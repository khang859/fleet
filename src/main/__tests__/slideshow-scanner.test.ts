import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanImageFolder } from '../slideshow-scanner';

describe('scanImageFolder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-slideshow-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns image files sorted by name with absolute paths', async () => {
    await writeFile(join(dir, 'b.png'), '');
    await writeFile(join(dir, 'a.jpg'), '');
    await writeFile(join(dir, 'c.webp'), '');
    const result = await scanImageFolder(dir);
    expect(result).toEqual([join(dir, 'a.jpg'), join(dir, 'b.png'), join(dir, 'c.webp')]);
  });

  it('filters out non-image files and directories', async () => {
    await writeFile(join(dir, 'notes.txt'), '');
    await writeFile(join(dir, 'pic.PNG'), '');
    await mkdir(join(dir, 'sub.png'));
    const result = await scanImageFolder(dir);
    expect(result).toEqual([join(dir, 'pic.PNG')]);
  });

  it('returns [] for a missing folder', async () => {
    expect(await scanImageFolder(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('returns [] for an empty folder path', async () => {
    expect(await scanImageFolder('')).toEqual([]);
  });
});
