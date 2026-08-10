import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  CopilotSession,
  CopilotSettings,
  CopilotPosition,
  CopilotChatMessage
} from '../shared/types';

// Typed wrapper for ipcRenderer.invoke to avoid unsafe-return at every IPC call site.
// The cast is safe: callers declare the return type, and main process implements it.
// eslint-disable-next-line @typescript-eslint/promise-function-async
function typedInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const copilotApi = {
  getSessions: async (): Promise<CopilotSession[]> =>
    typedInvoke<CopilotSession[]>(IPC_CHANNELS.COPILOT_SESSIONS),

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
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_RESPOND_PERMISSION, {
      toolUseId,
      decision,
      reason
    }),

  getSettings: async (): Promise<CopilotSettings> =>
    typedInvoke<CopilotSettings>(IPC_CHANNELS.COPILOT_GET_SETTINGS),

  setSettings: async (partial: Partial<CopilotSettings>): Promise<void> =>
    typedInvoke<void>(IPC_CHANNELS.COPILOT_SET_SETTINGS, partial),

  installHooks: async (): Promise<boolean> =>
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_INSTALL_HOOKS),

  uninstallHooks: async (): Promise<boolean> =>
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS),

  hookStatus: async (): Promise<boolean> => typedInvoke<boolean>(IPC_CHANNELS.COPILOT_HOOK_STATUS),

  installHooksTo: async (configDir: string): Promise<boolean> =>
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, configDir),

  uninstallHooksFrom: async (configDir: string): Promise<boolean> =>
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS_FROM, configDir),

  hookStatusFor: async (configDir: string): Promise<boolean> =>
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, configDir),

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
    typedInvoke<{ workspaceId: string; workspaceName: string } | null>(
      IPC_CHANNELS.COPILOT_GET_ACTIVE_WORKSPACE
    ),

  serviceStatus: async (): Promise<{ hookInstalled: boolean; claudeDetected: boolean }> =>
    typedInvoke<{ hookInstalled: boolean; claudeDetected: boolean }>(
      IPC_CHANNELS.COPILOT_SERVICE_STATUS
    ),

  getPosition: async (): Promise<CopilotPosition | null> =>
    typedInvoke<CopilotPosition | null>(IPC_CHANNELS.COPILOT_POSITION_GET),

  setPosition: async (x: number, y: number): Promise<void> =>
    typedInvoke<void>(IPC_CHANNELS.COPILOT_POSITION_SET, { x, y }),

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
    typedInvoke<CopilotChatMessage[]>(IPC_CHANNELS.COPILOT_CHAT_HISTORY, { sessionId, cwd }),

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
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_SEND_MESSAGE, { sessionId, message }),

  focusTerminal: async (sessionId: string): Promise<boolean> =>
    typedInvoke<boolean>(IPC_CHANNELS.COPILOT_FOCUS_TERMINAL, { sessionId })
};

contextBridge.exposeInMainWorld('copilot', copilotApi);

export type CopilotApi = typeof copilotApi;
