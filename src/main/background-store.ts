import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createLogger } from './logger';
import { backgroundMediaKind, MAX_BACKGROUND_BYTES } from '../shared/background-media';
import { getFileExtension } from '../shared/file-open';
import type { Dirent } from 'node:fs';
import type { BackgroundAdoptResponse } from '../shared/ipc-api';
import type { TerminalBackground } from '../shared/types';

const log = createLogger('background-store');

/**
 * Pictures the user promoted to a wallpaper, kept where nothing else will
 * delete them.
 *
 * A background is a path in settings and nothing more, so whatever that path
 * points at has to outlive every other reason the file might exist. An image
 * the agent drew does not: it lives under the conversation that made it, and
 * deleting that conversation takes the picture with it - which would leave the
 * user staring at a blank window with no idea what they did wrong. So a picture
 * that becomes a background is copied here first, and the setting points at the
 * copy.
 */
const BACKGROUNDS_DIR = join(homedir(), '.fleet', 'backgrounds');

/**
 * How long a copy is safe from the sweep whether or not a setting names it.
 *
 * A copy is written before the setting that points at it is saved, and the
 * sweep runs on every background setting the user touches. A picture closes
 * that gap in a millisecond; a video is seconds in the copying, and a batch of
 * them leaves the first ones waiting on the last. Nudging a slider in that time
 * would otherwise delete a file the user is in the middle of choosing.
 */
const FRESH_MS = 10 * 60 * 1000;

/**
 * The picture's own name, cut down to something safe to write anywhere.
 *
 * The copy could be named by its digest alone and work perfectly, but the
 * settings pane shows the tail of whatever path it holds - so a wallpaper the
 * user chose as `sunset.jpg` would come back to them as thirty-two hex
 * characters. The digest still follows, and still does the deduplicating.
 */
function readableStem(sourcePath: string): string {
  const stem = basename(sourcePath, extname(sourcePath))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return stem === '' ? '' : `${stem}-`;
}

/**
 * Copy a picture or a video into the backgrounds folder and say where it landed.
 *
 * Named by the file's own name and the hash of its contents, which makes
 * adopting the same file twice free and idempotent: the second call finds
 * the file already there, skips the write, and returns the same path - so
 * promoting one image to both the background and the slideshow stores it once,
 * and a slideshow cannot end up holding two copies of the same picture. Two
 * files with identical bytes under different names do each get stored, which
 * is the price of a name the settings pane can show back to the user.
 *
 * Reads the path as given. Every file that reaches here came from a pane
 * running on this machine, so there is no WSL distro to bridge into the way
 * `fleet-image://` has to when it serves one back.
 */
export async function adoptBackground(
  sourcePath: string,
  /** Where the copy goes. Overridden only by tests, the way the image store's
   *  root is - nothing else has any business writing somewhere else. */
  dir: string = BACKGROUNDS_DIR
): Promise<BackgroundAdoptResponse> {
  const kind = backgroundMediaKind(sourcePath);
  if (kind === null) {
    const ext = getFileExtension(sourcePath);
    return { success: false, error: `${ext || 'That file'} cannot be used as a background` };
  }

  let partial: string | null = null;
  try {
    // Also where a source that is already gone fails, before any folder exists.
    if ((await stat(sourcePath)).size > MAX_BACKGROUND_BYTES[kind]) {
      return { success: false, error: `That ${kind} is too large to use as a background` };
    }
    await mkdir(dir, { recursive: true });

    // Streamed, because a video does not fit in memory the way a picture does.
    // The name is not known until the last byte is hashed, so the copy is
    // written under a throwaway one and renamed. The digest is of the bytes
    // that were written, not of a second read of a file that may have changed.
    partial = join(dir, `${randomUUID()}.partial`);
    const hash = createHash('sha256');
    await pipeline(
      createReadStream(sourcePath),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial)
    );

    const ext = extname(sourcePath).toLowerCase();
    const target = join(dir, `${readableStem(sourcePath)}${hash.digest('hex').slice(0, 32)}${ext}`);
    if (existsSync(target)) {
      // Found rather than written, so it may be an old copy nothing points at
      // yet. Made fresh again so the sweep gives it the same grace as a new one.
      const now = new Date();
      const kept = await utimes(target, now, now).then(
        () => true,
        // The sweep took it in between, so the copy just made goes in its place.
        () => false
      );
      if (kept) return { success: true, path: target };
    }
    await rename(partial, target);
    log.info('adopted a background', { sourcePath, target });
    return { success: true, path: target };
  } catch (err) {
    log.warn('could not adopt a background', { sourcePath, error: String(err) });
    return { success: false, error: `That ${kind} could not be saved as a background` };
  } finally {
    if (partial !== null) await rm(partial, { force: true });
  }
}

/**
 * Every path a background setting still depends on.
 *
 * `filePaths` counts even while the slideshow is running off a folder, and
 * `stashedImagePath` counts even though nothing is drawing it: both are lists
 * the user gets back with one click, and a sweep that kept only what is on
 * screen would empty them behind their back.
 */
export function backgroundReferences(background: TerminalBackground): string[] {
  const paths = [
    background.imagePath,
    background.stashedImagePath,
    ...background.slideshow.filePaths
  ];
  return paths.filter((path): path is string => path !== null && path !== '');
}

/**
 * Delete every copy in the store that no setting points at any more.
 *
 * A sweep rather than a matched delete for each removal, because the ways a
 * background stops being wanted are not one thing: removing a slideshow image,
 * clearing the list, resetting to defaults, switching to a folder and a crash
 * halfway through any of them all leave the same orphan, and a sweep collects
 * it in every case - including the ones that happened while an older build was
 * running.
 *
 * Only ever touches files inside `dir`. A background pointing at a picture
 * somewhere else on disk is the user's own file, and the whole point of the
 * store is that Fleet deletes only what Fleet put there.
 *
 * Leaves anything written in the last `FRESH_MS` alone - see there. A copy
 * abandoned halfway by a crash is nothing special: it stops being fresh, no
 * setting names it, and a later sweep takes it.
 */
export function pruneBackgroundStore(
  background: TerminalBackground,
  dir: string = BACKGROUNDS_DIR,
  now: number = Date.now()
): void {
  const keep = new Set(backgroundReferences(background));

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Nothing has been adopted yet, so nothing can be orphaned.
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    if (keep.has(path)) continue;
    try {
      if (now - statSync(path).mtimeMs < FRESH_MS) continue;
      unlinkSync(path);
      log.info('dropped an unused background', { path });
    } catch (err) {
      log.warn('could not drop an unused background', { path, error: String(err) });
    }
  }
}

/** Is this path already a copy this store owns? */
function isAdopted(path: string, dir: string): boolean {
  return resolve(dirname(path)) === resolve(dir);
}

/**
 * Copy anything a background still points at from outside the store into it.
 *
 * For settings written before backgrounds were copied at all: those paths are
 * the user's own files, and the day one is moved or deleted the window goes
 * blank with nothing to explain why. Returns the settings as they should now
 * read, or null when every path is already a copy - which is every launch
 * after the first, and costs a string comparison per path rather than any
 * reading of files.
 *
 * A path that cannot be adopted is left exactly as it was. Either the picture
 * is already gone, in which case rewriting the path changes nothing, or it is
 * something the store will not take - and dropping the user's wallpaper over
 * that is a worse answer than leaving a path that still works.
 */
export async function backfillBackgroundStore(
  background: TerminalBackground,
  dir: string = BACKGROUNDS_DIR
): Promise<TerminalBackground | null> {
  let changed = false;

  const adopt = async (path: string): Promise<string> => {
    if (isAdopted(path, dir)) return path;
    const result = await adoptBackground(path, dir);
    if (!result.success) return path;
    changed = true;
    return result.path;
  };

  // Content-addressed names mean two of the old paths can land on one copy, so
  // the list is deduplicated after the fact rather than trusted to stay as long
  // as it was.
  const adoptedFiles: string[] = [];
  for (const path of background.slideshow.filePaths) adoptedFiles.push(await adopt(path));
  const filePaths = [...new Set(adoptedFiles)];
  if (filePaths.length !== background.slideshow.filePaths.length) changed = true;

  const next: TerminalBackground = {
    ...background,
    imagePath: background.imagePath === null ? null : await adopt(background.imagePath),
    stashedImagePath:
      background.stashedImagePath === null ? null : await adopt(background.stashedImagePath),
    slideshow: { ...background.slideshow, filePaths }
  };
  return changed ? next : null;
}
