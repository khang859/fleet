import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { RuneFileChatService } from './rune-file-chat-service';
import type {
  RuneAssistSendRequest,
  RuneAssistStopRequest,
  RuneAssistResetRequest,
  RuneAssistStateRequest,
  RuneAssistState
} from '../../shared/ipc-api';

export function registerRuneAssistIpc(service: RuneFileChatService): void {
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_SEND, (_e, req: RuneAssistSendRequest) => {
    service.sendMessage(req);
  });
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_STOP, (_e, req: RuneAssistStopRequest) => {
    service.stop(req.paneId);
  });
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_RESET, (_e, req: RuneAssistResetRequest) => {
    service.reset(req.cwd);
  });
  ipcMain.handle(
    IPC_CHANNELS.RUNE_ASSIST_STATE,
    (_e, req: RuneAssistStateRequest): RuneAssistState =>
      req.filePath ? service.getStateForFile(req.filePath) : service.getState(req.cwd ?? '/')
  );
}
