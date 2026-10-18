import { lstat, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export { writeAtomic } from '../../fs-atomic';

/** A text file, or null when it is not there or cannot be read. */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The first part of `target` below `root` that is a symlink, from `root`, or
 * null when there is none. A part not there yet ends the walk.
 */
export async function firstLink(root: string, target: string): Promise<string | null> {
  let at = root;
  for (const part of relative(root, target).split(sep)) {
    at = join(at, part);
    const stat = await lstat(at).catch(() => null);
    if (stat === null) return null;
    if (stat.isSymbolicLink()) return relative(root, at);
  }
  return null;
}
