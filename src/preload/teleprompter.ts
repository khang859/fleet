import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  SetSourceResult,
  TeleprompterCommand,
  TeleprompterSourceRequest,
  TeleprompterState
} from '../shared/teleprompter';

// Typed wrapper for ipcRenderer.invoke to avoid unsafe-return at every IPC call site.
// The cast is safe: callers declare the return type, and main process implements it.
// eslint-disable-next-line @typescript-eslint/promise-function-async
function typedInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const teleprompterApi = {
  getState: async (): Promise<TeleprompterState> =>
    typedInvoke<TeleprompterState>(IPC_CHANNELS.TELEPROMPTER_GET_STATE),

  onState: (cb: (state: TeleprompterState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TeleprompterState): void => {
      cb(state);
    };
    ipcRenderer.on(IPC_CHANNELS.TELEPROMPTER_STATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TELEPROMPTER_STATE, handler);
  },

  command: async (command: TeleprompterCommand): Promise<TeleprompterState> =>
    typedInvoke<TeleprompterState>(IPC_CHANNELS.TELEPROMPTER_COMMAND, command),

  setSource: async (source: TeleprompterSourceRequest): Promise<SetSourceResult> =>
    typedInvoke<SetSourceResult>(IPC_CHANNELS.TELEPROMPTER_SET_SOURCE, source),

  resize: (width: number, height: number): void =>
    ipcRenderer.send(IPC_CHANNELS.TELEPROMPTER_RESIZE, { width, height })
};

contextBridge.exposeInMainWorld('teleprompter', teleprompterApi);

export type TeleprompterApi = typeof teleprompterApi;
