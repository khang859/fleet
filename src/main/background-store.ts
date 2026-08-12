import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from './logger';
import { IMAGE_EXTENSIONS } from './slideshow-scanner';
import type { BackgroundAdoptResponse } from '../shared/ipc-api';

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
 * Copy a picture into the backgrounds folder and say where it landed.
 *
 * Named by the hash of its contents, which makes adopting the same picture
 * twice free and idempotent: the second call finds the file already there,
 * skips the write, and returns the same path - so promoting one image to both
 * the background and the slideshow stores it once, and a slideshow cannot end
 * up holding two copies of the same picture under two names.
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
    const target = join(dir, `${digest}${ext}`);
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
