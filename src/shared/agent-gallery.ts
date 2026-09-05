/**
 * Every picture the agent has made, across every conversation.
 *
 * A generated image is filed under the conversation that produced it and is
 * deleted with it, which is right for the file but wrong for finding it again:
 * the folder is a uuid, the filename is a uuid, and the conversation may be one
 * of forty. So the gallery reads the store rather than any one session, and the
 * only thing it needs from a session is what that picture was asked for.
 */

/** One image, as the grid draws it. */
export type GalleryImage = {
  /** Absolute path on disk. Also the key: no two of these can collide. */
  path: string;
  /** The conversation that made it, which is the folder it sits in. */
  sessionId: string;
  /** Epoch ms, and what the grid is ordered by. */
  modifiedAt: number;
  size: number;
};

/**
 * Where the next page starts.
 *
 * A position rather than an offset, because the folder is written to while it
 * is being read: a picture generated between two pages would shift every image
 * after it down by one, and an offset would then skip one and repeat another.
 * The path breaks ties, since two files written in the same millisecond is a
 * batch of images arriving together rather than a curiosity.
 */
export type GalleryCursor = { modifiedAt: number; path: string };

export type GalleryPage = {
  images: GalleryImage[];
  /** `null` when this page is the end of the store. */
  next: GalleryCursor | null;
};

/**
 * What a picture can say about itself, read only when one is opened.
 *
 * Kept off {@link GalleryImage} because every field here costs a session file
 * read and parse, and a grid of sixty thumbnails would pay sixty of them to
 * fill in text that is only ever shown for the one being looked at.
 */
export type GalleryMetadata = {
  sessionId: string;
  /** The conversation's name, or `null` if it never earned one. */
  title: string | null;
  /** What was asked for, or `null` when the session no longer says. */
  prompt: string | null;
};
