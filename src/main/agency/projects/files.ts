import { readFile } from 'node:fs/promises';

export { writeAtomic } from '../../fs-atomic';

/** A text file, or null when it is not there or cannot be read. */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
