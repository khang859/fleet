import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import {
  TELEPROMPTER_NOTES_FILTERS,
  type SetSourceResult,
  type TeleprompterState
} from '../../shared/teleprompter';
import {
  TeleprompterCommandSchema,
  TeleprompterResizeSchema,
  TeleprompterSourceSchema
} from './schema';
import type { TeleprompterService } from './service';

/** The notes file picker, over the window that asked for it. Resolves to null when dismissed. */
async function pickNotesFile(parent: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: TELEPROMPTER_NOTES_FILTERS
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Both the overlay and the main window (Settings, palette) talk to the service through these. */
export function registerTeleprompterIpcHandlers(service: TeleprompterService): void {
  ipcMain.handle(IPC_CHANNELS.TELEPROMPTER_GET_STATE, (): TeleprompterState => service.getState());

  ipcMain.handle(
    IPC_CHANNELS.TELEPROMPTER_COMMAND,
    async (_event, payload: unknown): Promise<TeleprompterState> => {
      const parsed = TeleprompterCommandSchema.safeParse(payload);
      if (!parsed.success) return service.getState();
      return service.dispatch(parsed.data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TELEPROMPTER_SET_SOURCE,
    async (event, payload: unknown): Promise<SetSourceResult> => {
      const parsed = TeleprompterSourceSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, error: 'Invalid notes source.' };
      if (parsed.data.kind !== 'pick') return service.setSource(parsed.data);
      const path = await pickNotesFile(BrowserWindow.fromWebContents(event.sender));
      return path ? service.setSource({ kind: 'file', path }) : { ok: true, cancelled: true };
    }
  );

  ipcMain.on(IPC_CHANNELS.TELEPROMPTER_RESIZE, (_event, payload: unknown) => {
    const parsed = TeleprompterResizeSchema.safeParse(payload);
    if (parsed.success) service.resize(parsed.data.width, parsed.data.height);
  });
}
