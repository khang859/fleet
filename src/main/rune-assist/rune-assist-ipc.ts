import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { RuneFileChatService } from './rune-file-chat-service';
import type {
  RuneAssistSendRequest,
  RuneAssistStopRequest,
  RuneAssistResetRequest,
  RuneAssistState
} from '../../shared/ipc-api';

export function registerRuneAssistIpc(service: RuneFileChatService): void {
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_SEND, (_e, req: RuneAssistSendRequest) => {
    service.sendMessage(req);
  });
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_STOP, (_e, req: RuneAssistStopRequest) => {
    service.stop(req.cwd);
  });
  ipcMain.handle(IPC_CHANNELS.RUNE_ASSIST_RESET, (_e, req: RuneAssistResetRequest) => {
    service.reset(req.cwd);
  });
  ipcMain.handle(
    IPC_CHANNELS.RUNE_ASSIST_STATE,
    (_e, cwd: string): RuneAssistState => service.getState(cwd)
  );
}
