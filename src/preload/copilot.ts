import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  CopilotSession,
  CopilotSettings,
  CopilotPosition,
  CopilotChatMessage,
} from '../shared/types';

const copilotApi = {
  getSessions: (): Promise<CopilotSession[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SESSIONS),

  onSessions: (cb: (sessions: CopilotSession[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessions: CopilotSession[]): void => {
      cb(sessions);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_SESSIONS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_SESSIONS, handler);
  },

  respondPermission: (
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_RESPOND_PERMISSION, {
      toolUseId,
      decision,
      reason,
    }),

  getSettings: (): Promise<CopilotSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_GET_SETTINGS),

  setSettings: (partial: Partial<CopilotSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SET_SETTINGS, partial),

  installHooks: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS),

  uninstallHooks: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS),

  hookStatus: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_HOOK_STATUS),

  getPosition: (): Promise<CopilotPosition | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_POSITION_GET),

  setPosition: (x: number, y: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_POSITION_SET, { x, y }),

  setExpanded: (expanded: boolean): void =>
    ipcRenderer.send('copilot:set-expanded', expanded),

  toggleExpanded: (): void =>
    ipcRenderer.send('copilot:toggle-expanded'),

  onExpandedChanged: (cb: (expanded: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, expanded: boolean): void => {
      cb(expanded);
    };
    ipcRenderer.on('copilot:expanded-changed', handler);
    return () => ipcRenderer.removeListener('copilot:expanded-changed', handler);
  },

  getChatHistory: (sessionId: string, cwd: string): Promise<CopilotChatMessage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_CHAT_HISTORY, { sessionId, cwd }),

  onChatUpdated: (
    cb: (data: { sessionId: string; messages: CopilotChatMessage[] }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; messages: CopilotChatMessage[] }
    ): void => {
      cb(data);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_CHAT_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_CHAT_UPDATED, handler);
  },

  sendMessage: (sessionId: string, message: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SEND_MESSAGE, { sessionId, message }),

  focusTerminal: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_FOCUS_TERMINAL, { sessionId }),
};

contextBridge.exposeInMainWorld('copilot', copilotApi);

export type CopilotApi = typeof copilotApi;
