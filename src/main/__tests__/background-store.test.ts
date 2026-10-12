import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  adoptBackground,
  backfillBackgroundStore,
  pruneBackgroundStore
} from '../background-store';
import { DEFAULT_TERMINAL_BACKGROUND, type TerminalBackground } from '../../shared/types';

/** A background pointing at exactly these things and nothing else. */
function background(patch: Partial<TerminalBackground>): TerminalBackground {
  return { ...DEFAULT_TERMINAL_BACKGROUND, ...patch };
}

/** A sweep run long enough after the copies were made that none is still fresh. */
const LATER = Date.now() + 60 * 60 * 1000;

function slideshowOf(filePaths: string[]): Pick<TerminalBackground, 'slideshow'> {
  return { slideshow: { ...DEFAULT_TERMINAL_BACKGROUND.slideshow, filePaths } };
}

describe('adoptBackground', () => {
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

    const result = await adoptBackground(source, dest);

    expect(result.success).toBe(true);
    expect(await readdir(dest)).toHaveLength(1);
  });

  it('stores the same picture once, however many times it is adopted', async () => {
    const source = join(dir, 'a.png');
    await writeFile(source, 'identical bytes');

    const one = await adoptBackground(source, dest);
    const two = await adoptBackground(source, dest);

    expect(one).toEqual(two);
    expect(await readdir(dest)).toHaveLength(1);
  });

  it('keeps the name the user picked the file by, so settings can show it back', async () => {
    const source = join(dir, 'Sunset Over Bay.JPG');
    await writeFile(source, 'bytes');

    const result = await adoptBackground(source, dest);

    expect(result.success && basename(result.path)).toMatch(/^Sunset-Over-Bay-[0-9a-f]{32}\.jpg$/);
  });

  it('still lands somewhere sane when the name survives sanitising as nothing', async () => {
    const source = join(dir, '...png');
    await writeFile(source, 'bytes');

    const result = await adoptBackground(source, dest);

    expect(result.success && basename(result.path)).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  it('gives different pictures different names', async () => {
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    await writeFile(a, 'one');
    await writeFile(b, 'two');

    await adoptBackground(a, dest);
    await adoptBackground(b, dest);

    expect(await readdir(dest)).toHaveLength(2);
  });

  it('keeps the extension, so the copy is still recognisably an image', async () => {
    const source = join(dir, 'a.WEBP');
    await writeFile(source, 'bytes');

    const result = await adoptBackground(source, dest);

    expect(result.success && result.path.endsWith('.webp')).toBe(true);
  });

  it('refuses a file type the slideshow scanner would skip', async () => {
    const source = join(dir, 'a.svg');
    await writeFile(source, '<svg/>');

    expect(await adoptBackground(source, dest)).toEqual({
      success: false,
      error: '.svg cannot be used as a background'
    });
  });

  it('refuses something that is not an image at all', async () => {
    const source = join(dir, 'notes.txt');
    await writeFile(source, 'hello');

    expect((await adoptBackground(source, dest)).success).toBe(false);
  });

  it('takes a video the same way it takes a picture', async () => {
    const source = join(dir, 'Rain Loop.MP4');
    await writeFile(source, 'pretend mp4');

    const result = await adoptBackground(source, dest);

    expect(result.success && basename(result.path)).toMatch(/^Rain-Loop-[0-9a-f]{32}\.mp4$/);
  });

  it('stores exactly the bytes it was given, named by their digest', async () => {
    // Several stream chunks long, so a copy that dropped or reordered one shows.
    const bytes = Buffer.alloc(300_000, 'fleet');
    const source = join(dir, 'big.webm');
    await writeFile(source, bytes);

    const result = await adoptBackground(source, dest);
    if (!result.success) throw new Error(result.error);

    expect((await readFile(result.path)).equals(bytes)).toBe(true);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    expect(basename(result.path)).toBe(`big-${digest}.webm`);
  });

  it('leaves nothing half-written behind', async () => {
    const source = join(dir, 'a.mp4');
    await writeFile(source, 'bytes');

    await adoptBackground(source, dest);
    await adoptBackground(source, dest);

    expect((await readdir(dest)).filter((name) => name.endsWith('.partial'))).toEqual([]);
  });

  it('stores one copy when the same file is adopted twice at once', async () => {
    const source = join(dir, 'a.mp4');
    await writeFile(source, 'bytes');

    const [one, two] = await Promise.all([
      adoptBackground(source, dest),
      adoptBackground(source, dest)
    ]);

    expect(one).toEqual(two);
    expect(await readdir(dest)).toHaveLength(1);
  });

  it('creates no folder for a picture that is already gone', async () => {
    await adoptBackground(join(dir, 'missing.mp4'), dest);

    expect(await readdir(dir)).toEqual([]);
  });

  it('fails rather than throws when the picture is already gone', async () => {
    const result = await adoptBackground(join(dir, 'missing.png'), dest);

    expect(result.success).toBe(false);
  });
});

describe('pruneBackgroundStore', () => {
  let dir: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-bg-prune-'));
    dest = join(dir, 'backgrounds');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Adopt a picture and hand back where the copy landed. */
  async function adopted(name: string, bytes: string): Promise<string> {
    const source = join(dir, name);
    await writeFile(source, bytes);
    const result = await adoptBackground(source, dest);
    if (!result.success) throw new Error(result.error);
    return result.path;
  }

  it('drops a copy no setting points at any more', async () => {
    const kept = await adopted('kept.png', 'one');
    await adopted('dropped.png', 'two');

    pruneBackgroundStore(background({ imagePath: kept }), dest, LATER);

    expect(await readdir(dest)).toEqual([basename(kept)]);
  });

  it('keeps every picture the slideshow still lists', async () => {
    const a = await adopted('a.png', 'one');
    const b = await adopted('b.png', 'two');
    await adopted('c.png', 'three');

    pruneBackgroundStore(background(slideshowOf([a, b])), dest, LATER);

    expect((await readdir(dest)).sort()).toEqual([basename(a), basename(b)].sort());
  });

  it('keeps the slideshow list while the show is running off a folder', async () => {
    const listed = await adopted('listed.png', 'one');
    const folder = background({
      slideshow: {
        ...DEFAULT_TERMINAL_BACKGROUND.slideshow,
        source: 'folder',
        folderPath: dir,
        filePaths: [listed]
      }
    });

    pruneBackgroundStore(folder, dest, LATER);

    expect(await readdir(dest)).toEqual([basename(listed)]);
  });

  it('keeps the picture stashed behind the None mode', async () => {
    const stashed = await adopted('stashed.png', 'one');

    pruneBackgroundStore(background({ imagePath: null, stashedImagePath: stashed }), dest, LATER);

    expect(await readdir(dest)).toEqual([basename(stashed)]);
  });

  it('empties the store when nothing points at anything', async () => {
    await adopted('a.png', 'one');
    await adopted('b.png', 'two');

    pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest, LATER);

    expect(await readdir(dest)).toEqual([]);
  });

  it('leaves the user own files alone, wherever the setting points', async () => {
    const outside = join(dir, 'mine.png');
    await writeFile(outside, 'bytes');

    pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest, LATER);

    expect(await readdir(dir)).toContain('mine.png');
  });

  it('leaves a copy alone while it is too new for its setting to have been saved', async () => {
    await adopted('just-picked.mp4', 'one');

    pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest);

    expect(await readdir(dest)).toHaveLength(1);
  });

  it('leaves a copy that is still being written alone, and collects an abandoned one', async () => {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'in-flight.partial'), 'half a video');

    pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest);
    expect(await readdir(dest)).toEqual(['in-flight.partial']);

    pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest, LATER);
    expect(await readdir(dest)).toEqual([]);
  });

  it('gives an old copy that was just picked again the same grace as a new one', async () => {
    const path = await adopted('again.png', 'one');
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(path, longAgo, longAgo);

    await adopted('again.png', 'one');
    pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest);

    expect(await readdir(dest)).toEqual([basename(path)]);
  });

  it('does nothing at all before anything has been adopted', () => {
    expect(() => pruneBackgroundStore(DEFAULT_TERMINAL_BACKGROUND, dest)).not.toThrow();
  });
});

describe('backfillBackgroundStore', () => {
  let dir: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-bg-backfill-'));
    dest = join(dir, 'backgrounds');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes a copy of a picture the settings still point at from outside', async () => {
    const outside = join(dir, 'mine.png');
    await writeFile(outside, 'bytes');

    const next = await backfillBackgroundStore(background({ imagePath: outside }), dest);

    expect(next?.imagePath).toBe(join(dest, (await readdir(dest))[0]));
  });

  it('rewrites the whole slideshow, the stash included', async () => {
    const one = join(dir, 'one.png');
    const two = join(dir, 'two.png');
    const stash = join(dir, 'stash.png');
    await writeFile(one, '1');
    await writeFile(two, '2');
    await writeFile(stash, '3');

    const next = await backfillBackgroundStore(
      background({ stashedImagePath: stash, ...slideshowOf([one, two]) }),
      dest
    );

    expect(next?.slideshow.filePaths.every((p) => p.startsWith(dest))).toBe(true);
    expect(next?.stashedImagePath?.startsWith(dest)).toBe(true);
    expect(await readdir(dest)).toHaveLength(3);
  });

  it('says nothing changed once every path is already a copy', async () => {
    const outside = join(dir, 'mine.png');
    await writeFile(outside, 'bytes');
    const once = await backfillBackgroundStore(background({ imagePath: outside }), dest);

    expect(once).not.toBeNull();
    expect(await backfillBackgroundStore(once as TerminalBackground, dest)).toBeNull();
  });

  it('leaves a path whose picture is already gone exactly as it was', async () => {
    const missing = join(dir, 'gone.png');

    expect(await backfillBackgroundStore(background({ imagePath: missing }), dest)).toBeNull();
  });

  it('collapses a list that named the same picture twice', async () => {
    const one = join(dir, 'one.png');
    await writeFile(one, 'bytes');

    const next = await backfillBackgroundStore(background(slideshowOf([one, one])), dest);

    expect(next?.slideshow.filePaths).toHaveLength(1);
  });
});
