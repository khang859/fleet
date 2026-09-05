import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { GalleryMetadata, GalleryPage } from '../../shared/agent-gallery';
import { galleryMetadataFor, listGallery } from './gallery';
import type { AgentSessionStore } from './session-store';

/**
 * The gallery's two questions.
 *
 * Read-only, and everything they can reach is inside the picture store: the
 * listing never leaves it, and the metadata lookup takes the session id from
 * the path's own parent folder and checks it is a uuid before it becomes a
 * filename. Nothing the renderer sends decides which folder is read.
 */

/** A page the grid can actually draw. Small enough to arrive at once, big
 *  enough that the first screenful is one round trip. */
const PAGE_LIMIT = 60;

const Cursor = z.object({ modifiedAt: z.number(), path: z.string() });
const ListArgs = z.object({ cursor: Cursor.nullable() });

export function registerAgentGalleryIpc(sessions: AgentSessionStore): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_GALLERY_LIST,
    async (_e, input: unknown): Promise<GalleryPage> => {
      const { cursor } = ListArgs.parse(input);
      return listGallery(cursor, PAGE_LIMIT);
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_GALLERY_META, (_e, input: unknown): GalleryMetadata | null =>
    galleryMetadataFor(sessions, z.string().min(1).parse(input))
  );
}
