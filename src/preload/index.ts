import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { homedir } from 'os';
import { IPC_CHANNELS } from '../shared/constants';
import type {
  PtyCreateRequest,
  PtyCreateResponse,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  PtyCwdPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  NotificationPayload,
  PaneFocusedPayload,
  AgentStatePayload,
  GitStatusPayload,
  GitIsRepoPayload,
} from '../shared/ipc-api';
import type { Workspace, FleetSettings } from '../shared/types';

const fleetApi = {
  pty: {
    create: (req: PtyCreateRequest): Promise<PtyCreateResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, req),
    input: (payload: PtyInputPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_INPUT, payload),
    resize: (payload: PtyResizePayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, payload),
    kill: (paneId: string): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_KILL, paneId),
    gc: (activePaneIds: string[]): void =>
      ipcRenderer.send(IPC_CHANNELS.PTY_GC, activePaneIds),
    onData: (callback: (payload: PtyDataPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyDataPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
    },
    onExit: (callback: (payload: PtyExitPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyExitPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler);
    },
    onCwd: (callback: (payload: PtyCwdPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyCwdPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.PTY_CWD, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_CWD, handler);
    },
  },
  layout: {
    save: (req: LayoutSaveRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SAVE, req),
    load: (workspaceId: string): Promise<Workspace> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD, workspaceId),
    list: (): Promise<LayoutListResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LIST),
    delete: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_DELETE, workspaceId),
  },
  notifications: {
    onNotification: (callback: (payload: NotificationPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: NotificationPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.NOTIFICATION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION, handler);
    },
    paneFocused: (payload: PaneFocusedPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PANE_FOCUSED, payload),
  },
  agentState: {
    onStateUpdate: (callback: (payload: AgentStatePayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentStatePayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.AGENT_STATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATE, handler);
    },
  },
  homeDir: homedir(),
  platform: process.platform,
  utils: {
    getFilePath: (file: File): string => webUtils.getPathForFile(file),
  },
  settings: {
    get: (): Promise<FleetSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: (settings: Partial<FleetSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),
  },
  git: {
    isRepo: (cwd: string): Promise<GitIsRepoPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_IS_REPO, cwd),
    getStatus: (cwd: string): Promise<GitStatusPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd),
  },
  updates: {
    onUpdateDownloaded: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('fleet:update-downloaded', handler);
      return () => ipcRenderer.removeListener('fleet:update-downloaded', handler);
    },
    installUpdate: (): void =>
      ipcRenderer.send('fleet:install-update'),
  },
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
