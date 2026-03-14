import { contextBridge, ipcRenderer } from 'electron';
import { homedir } from 'os';
import { IPC_CHANNELS } from '../shared/constants';
import type {
  PtyCreateRequest,
  PtyCreateResponse,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  NotificationPayload,
  PaneFocusedPayload,
  AgentStatePayload,
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
  settings: {
    get: (): Promise<FleetSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: (settings: Partial<FleetSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),
  },
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
