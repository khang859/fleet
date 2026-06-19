import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  CopilotSession,
  CopilotSettings,
  CopilotPosition,
  CopilotChatMessage
} from '../shared/types';

const copilotApi = {
  getSessions: async (): Promise<CopilotSession[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SESSIONS),

  onSessions: (cb: (sessions: CopilotSession[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessions: CopilotSession[]): void => {
      cb(sessions);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_SESSIONS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_SESSIONS, handler);
  },

  respondPermission: async (
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_RESPOND_PERMISSION, {
      toolUseId,
      decision,
      reason
    }),

  getSettings: async (): Promise<CopilotSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_GET_SETTINGS),

  setSettings: async (partial: Partial<CopilotSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SET_SETTINGS, partial),

  installHooks: async (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS),

  uninstallHooks: async (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS),

  hookStatus: async (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.COPILOT_HOOK_STATUS),

  installHooksTo: async (configDir: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, configDir),

  uninstallHooksFrom: async (configDir: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS_FROM, configDir),

  hookStatusFor: async (configDir: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, configDir),

  onActiveWorkspace: (
    cb: (payload: { workspaceId: string; workspaceName: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { workspaceId: string; workspaceName: string }
    ): void => {
      cb(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, handler);
  },

  getActiveWorkspace: async (): Promise<{ workspaceId: string; workspaceName: string } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_GET_ACTIVE_WORKSPACE),

  serviceStatus: async (): Promise<{ hookInstalled: boolean; claudeDetected: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SERVICE_STATUS),

  getPosition: async (): Promise<CopilotPosition | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_POSITION_GET),

  setPosition: async (x: number, y: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_POSITION_SET, { x, y }),

  setExpanded: (expanded: boolean): void => ipcRenderer.send('copilot:set-expanded', expanded),

  toggleExpanded: (): void => ipcRenderer.send('copilot:toggle-expanded'),

  onExpandedChanged: (cb: (expanded: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { expanded: boolean }): void => {
      cb(data.expanded);
    };
    ipcRenderer.on('copilot:expanded-changed', handler);
    return () => ipcRenderer.removeListener('copilot:expanded-changed', handler);
  },

  getChatHistory: async (sessionId: string, cwd: string): Promise<CopilotChatMessage[]> =>
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

  sendMessage: async (sessionId: string, message: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_SEND_MESSAGE, { sessionId, message }),

  focusTerminal: async (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.COPILOT_FOCUS_TERMINAL, { sessionId })
};

contextBridge.exposeInMainWorld('copilot', copilotApi);

export type CopilotApi = typeof copilotApi;
