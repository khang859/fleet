import { getFileExtension } from './file-open';

/**
 * What a background may be, and everything that follows from which kind it is.
 *
 * The one list: the file dialog, the folder scan, the store that copies a pick
 * and the layer that draws it all ask here, so a file one of them accepts is a
 * file every other one can handle. An animated GIF or WebP is an image - it is
 * Chromium that animates it, not Fleet.
 */
export type BackgroundMediaKind = 'image' | 'video';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

/** Every one of these has to be a key of `MEDIA_MIME_TYPES`: `fleet-media://`
 *  answers 403 for anything else, and the background would be a blank window. */
export const BACKGROUND_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.m4v', '.mov'];

export function backgroundMediaKind(path: string): BackgroundMediaKind | null {
  const ext = getFileExtension(path);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (BACKGROUND_VIDEO_EXTENSIONS.includes(ext)) return 'video';
  return null;
}

/** The largest file the store will copy. Hashing reads all of it, so a mistaken
 *  pick cannot be unbounded - but a video is a different size of thing. */
export const MAX_BACKGROUND_BYTES: Record<BackgroundMediaKind, number> = {
  image: 64 * 1024 * 1024,
  video: 1024 * 1024 * 1024
};

const dotless = (extensions: string[]): string[] => extensions.map((ext) => ext.slice(1));

export const BACKGROUND_DIALOG_FILTERS = [
  {
    name: 'Images and videos',
    extensions: dotless([...IMAGE_EXTENSIONS, ...BACKGROUND_VIDEO_EXTENSIONS])
  },
  { name: 'Images', extensions: dotless(IMAGE_EXTENSIONS) },
  { name: 'Videos', extensions: dotless(BACKGROUND_VIDEO_EXTENSIONS) }
];
