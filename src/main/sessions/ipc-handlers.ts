// src/main/sessions/ipc-handlers.ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { SessionKey } from '../../shared/sessions';
import type { SessionsService } from './service';

export function registerSessionsIpcHandlers(service: SessionsService): void {
  ipcMain.handle(IPC_CHANNELS.SESSIONS_LIST, async () => service.list());
  ipcMain.handle(IPC_CHANNELS.SESSIONS_READ, async (_event, key: SessionKey) => service.read(key));
}
