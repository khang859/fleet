import { readdir } from 'fs/promises';
import { extname, join } from 'path';

/** What a background may be. Shared, because a picture the scanner would skip
 *  cannot be adopted as one either - it would work as a single image and go
 *  missing from a slideshow. */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/**
 * List image files in a folder (non-recursive), sorted by name.
 * Returns [] for a missing or unreadable folder — never throws.
 */
export async function scanImageFolder(folderPath: string): Promise<string[]> {
  if (!folderPath) return [];
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => join(folderPath, e.name))
      .sort();
  } catch {
    return [];
  }
}
