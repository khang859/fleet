// src/main/sessions/ipc-handlers.ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { SessionAgent } from '../../shared/sessions';
import type { SessionsService } from './service';

export function registerSessionsIpcHandlers(service: SessionsService): void {
  ipcMain.handle(IPC_CHANNELS.SESSIONS_LIST, async () => service.list());
  ipcMain.handle(
    IPC_CHANNELS.SESSIONS_READ,
    async (_event, args: { agent: SessionAgent; id: string; cwd: string }) =>
      service.read(args.agent, args.id, args.cwd)
  );
}
