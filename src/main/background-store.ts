import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from './logger';
import { IMAGE_EXTENSIONS } from './slideshow-scanner';
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

/** Hashing reads the whole file, so a mistaken pick cannot be unbounded. */
const MAX_BYTES = 64 * 1024 * 1024;

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
 * Copy a picture into the backgrounds folder and say where it landed.
 *
 * Named by the picture's own name and the hash of its contents, which makes
 * adopting the same picture twice free and idempotent: the second call finds
 * the file already there, skips the write, and returns the same path - so
 * promoting one image to both the background and the slideshow stores it once,
 * and a slideshow cannot end up holding two copies of the same picture. Two
 * files with identical bytes under different names do each get stored, which
 * is the price of a name the settings pane can show back to the user.
 *
 * Reads the path as given. Every picture that reaches here came from a pane
 * running on this machine, so there is no WSL distro to bridge into the way
 * `fleet-image://` has to when it serves one back.
 */
export function adoptBackgroundImage(
  sourcePath: string,
  /** Where the copy goes. Overridden only by tests, the way the image store's
   *  root is - nothing else has any business writing somewhere else. */
  dir: string = BACKGROUNDS_DIR
): BackgroundAdoptResponse {
  const ext = extname(sourcePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return { success: false, error: `${ext || 'That file'} cannot be used as a background` };
  }

  try {
    if (statSync(sourcePath).size > MAX_BYTES) {
      return { success: false, error: 'That image is too large to use as a background' };
    }
    // Read rather than stream: the digest needs the whole file anyway, and a
    // background is a picture someone is going to look at all day, not a large
    // asset. The read also fails here, before any folder is created, if the
    // source is gone.
    const bytes = readFileSync(sourcePath);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const target = join(dir, `${readableStem(sourcePath)}${digest}${ext}`);
    if (existsSync(target)) return { success: true, path: target };

    mkdirSync(dir, { recursive: true });
    // The bytes that were hashed, not the file they came from. Copying would
    // read the source a second time, and a file that changed in between would
    // be stored under the name of contents it no longer has.
    writeFileSync(target, bytes);
    log.info('adopted a background', { sourcePath, target });
    return { success: true, path: target };
  } catch (err) {
    log.warn('could not adopt a background', { sourcePath, error: String(err) });
    return { success: false, error: 'That image could not be saved as a background' };
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
 */
export function pruneBackgroundStore(
  background: TerminalBackground,
  dir: string = BACKGROUNDS_DIR
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
export function backfillBackgroundStore(
  background: TerminalBackground,
  dir: string = BACKGROUNDS_DIR
): TerminalBackground | null {
  let changed = false;

  const adopt = (path: string): string => {
    if (isAdopted(path, dir)) return path;
    const result = adoptBackgroundImage(path, dir);
    if (!result.success) return path;
    changed = true;
    return result.path;
  };

  // Content-addressed names mean two of the old paths can land on one copy, so
  // the list is deduplicated after the fact rather than trusted to stay as long
  // as it was.
  const filePaths = [...new Set(background.slideshow.filePaths.map(adopt))];
  if (filePaths.length !== background.slideshow.filePaths.length) changed = true;

  const next: TerminalBackground = {
    ...background,
    imagePath: background.imagePath === null ? null : adopt(background.imagePath),
    stashedImagePath:
      background.stashedImagePath === null ? null : adopt(background.stashedImagePath),
    slideshow: { ...background.slideshow, filePaths }
  };
  return changed ? next : null;
}
