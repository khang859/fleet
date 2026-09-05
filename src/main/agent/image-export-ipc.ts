import { BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { copyFile } from 'node:fs/promises';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ImageActionResult } from '../../shared/agent-image-export';
import { isAgentImagePath } from './image-store';
import { createLogger } from '../logger';

const log = createLogger('agent:image-export');

/**
 * Getting a picture out of Fleet.
 *
 * Until these existed the only way out of a conversation was to copy the path
 * and go find the file, which is a strange thing to ask of someone looking
 * straight at the image. A generated picture lives under `~/.fleet/agent` and is
 * deleted with the conversation that made it, so "save it somewhere" is not a
 * convenience here, it is the difference between keeping the thing and losing
 * it.
 *
 * Copying the picture itself is deliberately not here: it is the one action
 * that needs no file access, only a decoder, and Chromium's is far better than
 * `nativeImage`'s - which reads PNG and JPEG and nothing else, so a generated
 * WebP would be refused by the action most likely to be wanted. It lives in the
 * renderer instead, in `lib/image-export-actions.ts`.
 *
 * Every handler re-checks `isAgentImagePath` even though the renderer only ever
 * offers these on paths Fleet itself produced. The renderer is not where a path
 * is trusted: the same check guards what the image tool may read back as a
 * reference, and one handler here that skipped it would be a way to copy any
 * file on disk to anywhere else, asked for over IPC.
 */

const ImagePath = z.string().min(1);
const SaveAsArgs = z.object({ path: ImagePath, suggestedName: z.string().min(1).max(255) });

/** The one refusal all four share, so it reads the same wherever it surfaces. */
const NOT_OURS = 'That file is not one Fleet made';

export function registerAgentImageExportIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENT_IMAGE_SAVE_AS,
    async (event, input: unknown): Promise<ImageActionResult> => {
      const { path, suggestedName } = SaveAsArgs.parse(input);
      if (!isAgentImagePath(path)) return { success: false, error: NOT_OURS };

      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await (win === null
        ? dialog.showSaveDialog({ defaultPath: suggestedName })
        : dialog.showSaveDialog(win, { defaultPath: suggestedName }));
      // Cancelling is the user answering, not something going wrong. It gets a
      // quiet success so the renderer has nothing to complain about.
      if (result.canceled || result.filePath === '') return { success: true };

      try {
        await copyFile(path, result.filePath);
        return { success: true, path: result.filePath };
      } catch (err) {
        log.warn('save as failed', { path, error: String(err) });
        return { success: false, error: `Could not save the image: ${String(err)}` };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_IMAGE_REVEAL, (_e, input: unknown): ImageActionResult => {
    const path = ImagePath.parse(input);
    if (!isAgentImagePath(path)) return { success: false, error: NOT_OURS };
    shell.showItemInFolder(path);
    return { success: true };
  });

  /**
   * A drag out of the window and into a file manager.
   *
   * `on` rather than `handle`, because a drag has no answer: the OS takes over
   * the moment `startDrag` is called, and there is nothing left for the renderer
   * to wait on. A refusal here is silence for the same reason - the gesture
   * simply does not become a drag, which is what a failed drag looks like
   * anyway.
   */
  ipcMain.on(IPC_CHANNELS.AGENT_IMAGE_START_DRAG, (event, input: unknown) => {
    const parsed = ImagePath.safeParse(input);
    if (!parsed.success || !isAgentImagePath(parsed.data)) return;
    // `startDrag` throws on an empty icon rather than dragging without one, so
    // an undecodable file has to drop out here.
    const icon = nativeImage.createFromPath(parsed.data).resize({ width: 96, height: 96 });
    if (icon.isEmpty()) return;
    try {
      event.sender.startDrag({ file: parsed.data, icon });
    } catch (err) {
      log.warn('drag failed', { path: parsed.data, error: String(err) });
    }
  });
}
