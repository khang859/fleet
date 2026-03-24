import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  AdmiralStatusPayload,
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
  HostPlatform,
  AdmiralStateDetailPayload,
  StarbaseRuntimeStatus,
  SystemDepResult,
  CreateTabPayload,
  FileOpenInTabPayload,
  StarbaseSectorRow,
  StarbaseCrewRow,
  StarbaseMissionRow,
  StarbaseCommRow,
  StarbaseMemoRow,
  StarbaseSupplyRoute,
  StarbaseRetentionStats,
  StarbaseCleanupResult,
  StarbaseLogEntry,
  StarbaseStatusUpdatePayload,
  DeployResponse,
  ReaddirResponse,
  FileSearchRequest,
  FileSearchResponse
} from '../shared/ipc-api';
import type { Workspace, FleetSettings, UpdateStatus } from '../shared/types';

type Unsubscribe = () => void;

// Typed wrapper for ipcRenderer.invoke to avoid unsafe-return at every IPC call site.
// The cast is safe: callers declare the return type, and main process implements it.
// eslint-disable-next-line @typescript-eslint/promise-function-async
function typedInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-type-assertion
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function onChannel<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function getHomeDir(): string {
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      return userProfile;
    }

    const homeDrive = process.env.HOMEDRIVE;
    const homePath = process.env.HOMEPATH;
    if (homeDrive && homePath) {
      return homeDrive + homePath;
    }

    return '';
  }

  return process.env.HOME ?? '';
}

// Single IPC listener that routes PTY data to per-pane callbacks via Map lookup (O(1))
// instead of broadcasting to all N terminal listeners (O(N)).
const ptyDataListeners = new Map<string, (data: string) => void>();
// Track which panes have been paused by the main process so the renderer
// only sends ptyDrain IPC when actually needed (avoids no-op resume() calls).
const pausedPanes = new Set<string>();
ipcRenderer.on(
  IPC_CHANNELS.PTY_DATA,
  (_event: Electron.IpcRendererEvent, payload: PtyDataPayload) => {
    if (payload.paused) pausedPanes.add(payload.paneId);
    ptyDataListeners.get(payload.paneId)?.(payload.data);
  }
);

const fleetApi = {
  pty: {
    create: async (req: PtyCreateRequest): Promise<PtyCreateResponse> =>
      typedInvoke(IPC_CHANNELS.PTY_CREATE, req),
    input: (payload: PtyInputPayload): void => ipcRenderer.send(IPC_CHANNELS.PTY_INPUT, payload),
    resize: (payload: PtyResizePayload): void => ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, payload),
    kill: (paneId: string): void => ipcRenderer.send(IPC_CHANNELS.PTY_KILL, paneId),
    gc: (activePaneIds: string[]): void => ipcRenderer.send(IPC_CHANNELS.PTY_GC, activePaneIds),
    attach: async (paneId: string): Promise<{ data: string }> =>
      typedInvoke(IPC_CHANNELS.PTY_ATTACH, { paneId }),
    registerPaneData: (paneId: string, callback: (data: string) => void): Unsubscribe => {
      ptyDataListeners.set(paneId, callback);
      return () => {
        if (ptyDataListeners.get(paneId) === callback) {
          ptyDataListeners.delete(paneId);
        }
      };
    },
    onExit: (callback: (payload: PtyExitPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_EXIT, callback),
    onCwd: (callback: (payload: PtyCwdPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_CWD, callback)
  },
  layout: {
    save: async (req: LayoutSaveRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.LAYOUT_SAVE, req),
    load: async (workspaceId: string): Promise<Workspace> =>
      typedInvoke(IPC_CHANNELS.LAYOUT_LOAD, workspaceId),
    list: async (): Promise<LayoutListResponse> => typedInvoke(IPC_CHANNELS.LAYOUT_LIST),
    delete: async (workspaceId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.LAYOUT_DELETE, workspaceId)
  },
  notifications: {
    onNotification: (callback: (payload: NotificationPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.NOTIFICATION, callback),
    paneFocused: (payload: PaneFocusedPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PANE_FOCUSED, payload)
  },
  agentState: {
    onStateUpdate: (callback: (payload: AgentStatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_STATE, callback)
  },
  homeDir: getHomeDir(),
  platform: ((): HostPlatform => {
    const p = process.platform;
    if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
    return 'linux'; // fallback for unsupported platforms
  })(),
  utils: {
    getFilePath: (file: File): string => webUtils.getPathForFile(file)
  },
  settings: {
    get: async (): Promise<FleetSettings> => typedInvoke(IPC_CHANNELS.SETTINGS_GET),
    set: async (settings: Partial<FleetSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.SETTINGS_SET, settings)
  },
  git: {
    isRepo: async (cwd: string): Promise<GitIsRepoPayload> =>
      typedInvoke(IPC_CHANNELS.GIT_IS_REPO, cwd),
    getStatus: async (cwd: string): Promise<GitStatusPayload> =>
      typedInvoke(IPC_CHANNELS.GIT_STATUS, cwd)
  },
  admiral: {
    checkDependencies: async (): Promise<SystemDepResult[]> =>
      typedInvoke(IPC_CHANNELS.ADMIRAL_CHECK_DEPENDENCIES),
    getPaneId: async (): Promise<string | null> => typedInvoke(IPC_CHANNELS.ADMIRAL_PANE_ID),
    ensureStarted: async (): Promise<string | null> =>
      typedInvoke(IPC_CHANNELS.ADMIRAL_ENSURE_STARTED),
    restart: async (): Promise<string> => typedInvoke(IPC_CHANNELS.ADMIRAL_RESTART),
    reset: async (): Promise<string> => typedInvoke(IPC_CHANNELS.ADMIRAL_RESET),
    onStatusChanged: (callback: (payload: AdmiralStatusPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, callback),
    onStateDetail: (callback: (payload: AdmiralStateDetailPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, callback)
  },
  starbase: {
    getRuntimeStatus: async (): Promise<StarbaseRuntimeStatus> =>
      typedInvoke(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_GET),
    retryRuntimeBootstrap: async (): Promise<StarbaseRuntimeStatus> =>
      typedInvoke(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_RETRY),
    onRuntimeStatus: (callback: (payload: StarbaseRuntimeStatus) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_CHANGED, callback),
    listSectors: async (): Promise<StarbaseSectorRow[]> =>
      typedInvoke(IPC_CHANNELS.STARBASE_LIST_SECTORS),
    listCrew: async (filter?: { sectorId?: string; status?: string }): Promise<StarbaseCrewRow[]> =>
      typedInvoke(IPC_CHANNELS.STARBASE_CREW, filter),
    listMissions: async (filter?: {
      sectorId?: string;
      status?: string;
    }): Promise<StarbaseMissionRow[]> => typedInvoke(IPC_CHANNELS.STARBASE_MISSIONS, filter),
    getUnreadComms: async (): Promise<StarbaseCommRow[]> =>
      typedInvoke(IPC_CHANNELS.STARBASE_COMMS_UNREAD),
    listComms: async (opts?: { limit?: number }): Promise<StarbaseCommRow[]> =>
      typedInvoke(IPC_CHANNELS.STARBASE_LIST_COMMS, opts),
    markCommsRead: async (id: number): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.STARBASE_MARK_COMMS_READ, { id }),
    resolveComms: async (id: number, response: string): Promise<number> =>
      typedInvoke(IPC_CHANNELS.STARBASE_RESOLVE_COMMS, { id, response }),
    deleteComms: async (id: number): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.STARBASE_DELETE_COMMS, { id }),
    markAllCommsRead: async (): Promise<number> =>
      typedInvoke(IPC_CHANNELS.STARBASE_MARK_ALL_COMMS_READ),
    clearComms: async (): Promise<number> => typedInvoke(IPC_CHANNELS.STARBASE_CLEAR_COMMS),
    deployCrew: async (opts: {
      sectorId: string;
      prompt: string;
      summary?: string;
      missionId?: number;
    }): Promise<DeployResponse> => typedInvoke(IPC_CHANNELS.STARBASE_DEPLOY, opts),
    recallCrew: async (crewId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.STARBASE_RECALL, { crewId }),
    observeCrew: async (crewId: string): Promise<string> =>
      typedInvoke(IPC_CHANNELS.STARBASE_OBSERVE, { crewId }),
    messageCrew: async (crewId: string, message: string): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.STARBASE_MESSAGE_CREW, { crewId, message }),
    addMission: async (req: {
      sectorId: string;
      summary: string;
      prompt: string;
      priority?: number;
      dependsOnMissionId?: number;
    }): Promise<{ missionId: number }> => typedInvoke(IPC_CHANNELS.STARBASE_ADD_MISSION, req),
    onStatusUpdate: (callback: (payload: StarbaseStatusUpdatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_STATUS_UPDATE, callback),
    listSupplyRoutes: async (opts?: { sectorId?: string }): Promise<StarbaseSupplyRoute[]> =>
      typedInvoke(IPC_CHANNELS.STARBASE_LIST_SUPPLY_ROUTES, opts),
    addSupplyRoute: async (opts: {
      upstreamSectorId: string;
      downstreamSectorId: string;
    }): Promise<{ routeId: number }> => typedInvoke(IPC_CHANNELS.STARBASE_ADD_SUPPLY_ROUTE, opts),
    removeSupplyRoute: async (routeId: number): Promise<void> =>
      typedInvoke(IPC_CHANNELS.STARBASE_REMOVE_SUPPLY_ROUTE, { routeId }),
    getSupplyRouteGraph: async (): Promise<Record<string, string[]>> =>
      typedInvoke(IPC_CHANNELS.STARBASE_SUPPLY_ROUTE_GRAPH),
    listCargo: async (filter?: { sectorId?: string }): Promise<Array<Record<string, unknown>>> =>
      typedInvoke(IPC_CHANNELS.STARBASE_LIST_CARGO, filter),
    getRetentionStats: async (): Promise<StarbaseRetentionStats> =>
      typedInvoke(IPC_CHANNELS.STARBASE_RETENTION_STATS),
    retentionCleanup: async (): Promise<StarbaseCleanupResult> =>
      typedInvoke(IPC_CHANNELS.STARBASE_RETENTION_CLEANUP),
    retentionVacuum: async (): Promise<void> => typedInvoke(IPC_CHANNELS.STARBASE_RETENTION_VACUUM),
    getConfig: async (): Promise<Record<string, unknown>> =>
      typedInvoke(IPC_CHANNELS.STARBASE_GET_CONFIG),
    setConfig: async (key: string, value: unknown): Promise<void> =>
      typedInvoke(IPC_CHANNELS.STARBASE_SET_CONFIG, { key, value }),
    addSector: async (opts: {
      path: string;
      name?: string;
      description?: string;
    }): Promise<StarbaseSectorRow> => typedInvoke(IPC_CHANNELS.STARBASE_ADD_SECTOR, opts),
    removeSector: async (sectorId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, { sectorId }),
    updateSector: async (sectorId: string, fields: Record<string, unknown>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, { sectorId, fields }),
    memoList: async (): Promise<StarbaseMemoRow[]> => typedInvoke(IPC_CHANNELS.MEMO_LIST),
    memoRead: async (id: number): Promise<void> => typedInvoke(IPC_CHANNELS.MEMO_READ, id),
    memoDismiss: async (id: number): Promise<void> => typedInvoke(IPC_CHANNELS.MEMO_DISMISS, id),
    memoContent: async (filePath: string): Promise<string | null> =>
      typedInvoke(IPC_CHANNELS.MEMO_CONTENT, filePath),
    getShipsLog: async (opts?: { limit?: number }): Promise<StarbaseLogEntry[]> =>
      typedInvoke(IPC_CHANNELS.STARBASE_SHIPS_LOG, opts),
    onLogEntry: (callback: (entry: StarbaseLogEntry) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_LOG_ENTRY, callback)
  },
  system: {
    check: async (): Promise<SystemDepResult[]> =>
      typedInvoke(IPC_CHANNELS.SYSTEM_CHECK)
  },
  showFolderPicker: async (): Promise<string | null> =>
    typedInvoke(IPC_CHANNELS.SHOW_FOLDER_PICKER),
  ptyDrain: (paneId: string) => {
    if (pausedPanes.has(paneId)) {
      pausedPanes.delete(paneId);
      ipcRenderer.send(IPC_CHANNELS.PTY_DRAIN, { paneId });
    }
  },
  // TODO(#30): Crew tabs are no longer created — crews are now headless (stream-json).
  // This bridge remains for backwards compatibility but will not fire for new deployments.
  onCreateTab: (callback: (payload: CreateTabPayload) => void): Unsubscribe => {
    const cleanup = onChannel('fleet:create-tab', callback);
    // Signal to main that the renderer is ready to receive create-tab messages
    ipcRenderer.send('fleet:create-tab-ready');
    return cleanup;
  },
  file: {
    read: async (
      filePath: string
    ): Promise<
      | { success: true; data: { content: string; size: number; modifiedAt: number } }
      | { success: false; error: string }
    > => typedInvoke(IPC_CHANNELS.FILE_READ, filePath),
    write: async (
      filePath: string,
      content: string
    ): Promise<{ success: true } | { success: false; error: string }> =>
      typedInvoke(IPC_CHANNELS.FILE_WRITE, { filePath, content }),
    openDialog: async (opts: { defaultPath?: string } = {}): Promise<string[]> =>
      typedInvoke(IPC_CHANNELS.FILE_OPEN_DIALOG, opts),
    list: async (
      dirPath: string
    ): Promise<{
      success: true;
      files: Array<{ path: string; relativePath: string; name: string }>;
    }> => typedInvoke(IPC_CHANNELS.FILE_LIST, { dirPath }),
    readdir: async (dirPath: string): Promise<ReaddirResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_READDIR, { dirPath }),
    onOpenInTab: (callback: (payload: FileOpenInTabPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.FILE_OPEN_IN_TAB, callback),
    readBinary: async (
      filePath: string
    ): Promise<{ success: boolean; data?: { base64: string; mimeType: string }; error?: string }> =>
      typedInvoke(IPC_CHANNELS.FILE_READ_BINARY, filePath),
    stat: async (
      filePath: string
    ): Promise<{
      success: boolean;
      data?: { size: number; modifiedAt: number; mimeType: string };
      error?: string;
    }> => typedInvoke(IPC_CHANNELS.FILE_STAT, filePath),
    search: async (req: FileSearchRequest): Promise<FileSearchResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_SEARCH, req)
  },
  updates: {
    checkForUpdates: async (): Promise<void> => typedInvoke(IPC_CHANNELS.UPDATE_CHECK),
    onUpdateStatus: (callback: (status: UpdateStatus) => void): Unsubscribe => {
      return onChannel(IPC_CHANNELS.UPDATE_STATUS, callback);
    },
    installUpdate: (): void => ipcRenderer.send(IPC_CHANNELS.UPDATE_INSTALL),
    getVersion: async (): Promise<string> => typedInvoke(IPC_CHANNELS.GET_VERSION)
  },
  shell: {
    openExternal: async (url: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url)
  }
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
