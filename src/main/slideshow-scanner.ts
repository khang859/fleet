import { readdir } from 'fs/promises';
import { join } from 'path';
import { backgroundMediaKind } from '../shared/background-media';

/**
 * List the images and videos in a folder (non-recursive), sorted by name.
 * Returns [] for a missing or unreadable folder — never throws.
 */
export async function scanImageFolder(folderPath: string): Promise<string[]> {
  if (!folderPath) return [];
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && backgroundMediaKind(e.name) !== null)
      .map((e) => join(folderPath, e.name))
      .sort();
  } catch {
    return [];
  }
}
