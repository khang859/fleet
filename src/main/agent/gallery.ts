import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  GalleryCursor,
  GalleryImage,
  GalleryMetadata,
  GalleryPage
} from '../../shared/agent-gallery';
import { generatedImagePath } from '../../shared/agent-image-path';
import { AgentSessionId } from '../../shared/agent-session';
import { imageMimeFor } from './image-kinds';
import { AGENT_IMAGES_DIR } from './image-store';
import type { AgentSessionStore } from './session-store';
import { createLogger } from '../logger';

const log = createLogger('agent:gallery');

/**
 * Reading the picture store as one list.
 *
 * The store is a folder per conversation, which is the right shape for deleting
 * a session and wrong for every other question: nothing on disk records when a
 * picture was made except the file's own mtime, and nothing groups them by
 * anything but the conversation. So a page is a full scan, sorted, and cut at
 * the cursor.
 *
 * A full scan per page sounds worse than it is. The store holds one small
 * folder per conversation the user has actually had, and both readdir and stat
 * are answered from the OS cache after the first page. It is also the only
 * honest option: an index would be a second record of what is on disk, and the
 * one thing this store guarantees is that deleting a conversation takes its
 * pictures with it, index or no index.
 */

/** Newest first, and by path within a millisecond so the order is total. */
function newestFirst(a: GalleryImage, b: GalleryImage): number {
  return b.modifiedAt - a.modifiedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Whether `image` sorts strictly after the cursor, in the order above. */
function after(image: GalleryImage, cursor: GalleryCursor): boolean {
  if (image.modifiedAt !== cursor.modifiedAt) return image.modifiedAt < cursor.modifiedAt;
  return image.path > cursor.path;
}

async function scanSession(root: string, sessionId: string): Promise<GalleryImage[]> {
  const dir = join(root, sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // Removed between listing the store and reading this folder, which is what
    // deleting a conversation while the gallery is open looks like.
    return [];
  }

  const images: GalleryImage[] = [];
  for (const name of names) {
    // The same list the rest of the app calls a picture, rather than a second
    // copy of it here that has to be kept in step by hand.
    if (imageMimeFor(name) === null) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      images.push({ path, sessionId, modifiedAt: info.mtimeMs, size: info.size });
    } catch {
      // Same again, one file down.
    }
  }
  return images;
}

/**
 * One page of the store, newest first, starting after `cursor`.
 *
 * `root` is a parameter for the same reason `AgentImageStore` takes one: the
 * store is a folder under the user's home, and a test that could only run
 * against the real one would be a test of the machine it ran on.
 */
export async function listGallery(
  cursor: GalleryCursor | null,
  limit: number,
  root: string = AGENT_IMAGES_DIR
): Promise<GalleryPage> {
  let sessionIds: string[];
  try {
    sessionIds = await readdir(root);
  } catch (err) {
    // No store yet is the ordinary state of a fresh install, not a failure.
    if (!isMissing(err)) log.warn('could not read the picture store', { error: String(err) });
    return { images: [], next: null };
  }

  // Only folders a real conversation could have made. Anything else in here is
  // not ours, and a name that is not a uuid cannot be asked about later anyway.
  const valid = sessionIds.filter((id) => AgentSessionId.safeParse(id).success);
  const all = (await Promise.all(valid.map(async (id) => scanSession(root, id)))).flat();
  all.sort(newestFirst);

  const rest = cursor === null ? all : all.filter((image) => after(image, cursor));
  const images = rest.slice(0, limit);
  // A next cursor only when something is actually left, so the grid stops
  // asking rather than fetching one empty page to find out.
  const last = images[images.length - 1];
  const next =
    rest.length > images.length ? { modifiedAt: last.modifiedAt, path: last.path } : null;
  return { images, next };
}

/**
 * What the conversation behind one picture can still say about it.
 *
 * Read on opening rather than on listing: this replays a whole session file,
 * and doing it per thumbnail would make scrolling the grid the most expensive
 * thing in the app.
 *
 * A missing prompt is not an error. The session may have been written before
 * the picture, deleted since, or compacted past the turn that made it - and a
 * picture is still worth showing when nothing is left that says what it was
 * for.
 */
export function galleryMetadataFor(
  sessions: AgentSessionStore,
  path: string
): GalleryMetadata | null {
  const sessionId = basename(dirname(path));
  if (!AgentSessionId.safeParse(sessionId).success) return null;

  const replay = sessions.load(sessionId);
  let prompt: string | null = null;
  // The last call that made this file wins, though there can only be one: a
  // generated path is a fresh uuid every time.
  for (const message of replay.messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      if (generatedImagePath(part.call) !== path) continue;
      prompt = promptIn(part.call.args);
    }
  }
  return { sessionId, title: replay.title, prompt };
}

const ImageArgs = z.object({ prompt: z.string().min(1) });

/** The `prompt` argument the call was made with, if it still parses. */
function promptIn(args: string): string | null {
  try {
    const parsed = ImageArgs.safeParse(JSON.parse(args));
    return parsed.success ? parsed.data.prompt : null;
  } catch {
    return null;
  }
}

/** A folder or file that is not there, which is what a deleted conversation
 *  looks like from in here. */
function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
