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
  DeployResponse
} from '../shared/ipc-api';
import type { Workspace, FleetSettings } from '../shared/types';

type Unsubscribe = () => void;

function onChannel<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
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

const fleetApi = {
  pty: {
    create: async (req: PtyCreateRequest): Promise<PtyCreateResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, req),
    input: (payload: PtyInputPayload): void => ipcRenderer.send(IPC_CHANNELS.PTY_INPUT, payload),
    resize: (payload: PtyResizePayload): void => ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, payload),
    kill: (paneId: string): void => ipcRenderer.send(IPC_CHANNELS.PTY_KILL, paneId),
    gc: (activePaneIds: string[]): void => ipcRenderer.send(IPC_CHANNELS.PTY_GC, activePaneIds),
    attach: async (paneId: string): Promise<{ data: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_ATTACH, { paneId }),
    onData: (callback: (payload: PtyDataPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_DATA, callback),
    onExit: (callback: (payload: PtyExitPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_EXIT, callback),
    onCwd: (callback: (payload: PtyCwdPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_CWD, callback)
  },
  layout: {
    save: async (req: LayoutSaveRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SAVE, req),
    load: async (workspaceId: string): Promise<Workspace> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD, workspaceId),
    list: async (): Promise<LayoutListResponse> => ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LIST),
    delete: async (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_DELETE, workspaceId)
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
    get: async (): Promise<FleetSettings> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: async (settings: Partial<FleetSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings)
  },
  git: {
    isRepo: async (cwd: string): Promise<GitIsRepoPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_IS_REPO, cwd),
    getStatus: async (cwd: string): Promise<GitStatusPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd)
  },
  admiral: {
    checkDependencies: async (): Promise<SystemDepResult[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_CHECK_DEPENDENCIES),
    getPaneId: async (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_PANE_ID),
    ensureStarted: async (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_ENSURE_STARTED),
    restart: async (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_RESTART),
    reset: async (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_RESET),
    onStatusChanged: (callback: (payload: AdmiralStatusPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, callback),
    onStateDetail: (callback: (payload: AdmiralStateDetailPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, callback)
  },
  starbase: {
    getRuntimeStatus: async (): Promise<StarbaseRuntimeStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_GET),
    retryRuntimeBootstrap: async (): Promise<StarbaseRuntimeStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_RETRY),
    onRuntimeStatus: (callback: (payload: StarbaseRuntimeStatus) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_CHANGED, callback),
    listSectors: async (): Promise<StarbaseSectorRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_SECTORS),
    listCrew: async (filter?: { sectorId?: string; status?: string }): Promise<StarbaseCrewRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CREW, filter),
    listMissions: async (filter?: {
      sectorId?: string;
      status?: string;
    }): Promise<StarbaseMissionRow[]> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MISSIONS, filter),
    getUnreadComms: async (): Promise<StarbaseCommRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_COMMS_UNREAD),
    listComms: async (opts?: { limit?: number }): Promise<StarbaseCommRow[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_COMMS, opts),
    markCommsRead: async (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MARK_COMMS_READ, { id }),
    resolveComms: async (id: number, response: string): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RESOLVE_COMMS, { id, response }),
    deleteComms: async (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_DELETE_COMMS, { id }),
    markAllCommsRead: async (): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MARK_ALL_COMMS_READ),
    clearComms: async (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CLEAR_COMMS),
    deployCrew: async (opts: {
      sectorId: string;
      prompt: string;
      summary?: string;
      missionId?: number;
    }): Promise<DeployResponse> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_DEPLOY, opts),
    recallCrew: async (crewId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RECALL, { crewId }),
    observeCrew: async (crewId: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_OBSERVE, { crewId }),
    messageCrew: async (crewId: string, message: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MESSAGE_CREW, { crewId, message }),
    addMission: async (req: {
      sectorId: string;
      summary: string;
      prompt: string;
      priority?: number;
      dependsOnMissionId?: number;
    }): Promise<{ missionId: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_ADD_MISSION, req),
    onStatusUpdate: (callback: (payload: StarbaseStatusUpdatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_STATUS_UPDATE, callback),
    listSupplyRoutes: async (opts?: { sectorId?: string }): Promise<StarbaseSupplyRoute[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_SUPPLY_ROUTES, opts),
    addSupplyRoute: async (opts: {
      upstreamSectorId: string;
      downstreamSectorId: string;
    }): Promise<{ routeId: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_ADD_SUPPLY_ROUTE, opts),
    removeSupplyRoute: async (routeId: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_REMOVE_SUPPLY_ROUTE, { routeId }),
    getSupplyRouteGraph: async (): Promise<Record<string, string[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_SUPPLY_ROUTE_GRAPH),
    listCargo: async (filter?: { sectorId?: string }): Promise<Array<Record<string, unknown>>> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_CARGO, filter),
    getRetentionStats: async (): Promise<StarbaseRetentionStats> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RETENTION_STATS),
    retentionCleanup: async (): Promise<StarbaseCleanupResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RETENTION_CLEANUP),
    retentionVacuum: async (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RETENTION_VACUUM),
    getConfig: async (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_GET_CONFIG),
    setConfig: async (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_SET_CONFIG, { key, value }),
    addSector: async (opts: {
      path: string;
      name?: string;
      description?: string;
    }): Promise<StarbaseSectorRow> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_ADD_SECTOR, opts),
    removeSector: async (sectorId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, { sectorId }),
    updateSector: async (sectorId: string, fields: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, { sectorId, fields }),
    memoList: async (): Promise<StarbaseMemoRow[]> => ipcRenderer.invoke(IPC_CHANNELS.MEMO_LIST),
    memoRead: async (id: number): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MEMO_READ, id),
    memoDismiss: async (id: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_DISMISS, id),
    memoContent: async (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_CONTENT, filePath),
    getShipsLog: async (opts?: { limit?: number }): Promise<StarbaseLogEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_SHIPS_LOG, opts),
    onLogEntry: (callback: (entry: StarbaseLogEntry) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_LOG_ENTRY, callback)
  },
  system: {
    check: async (): Promise<Array<import('../shared/ipc-api').SystemDepResult>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_CHECK)
  },
  showFolderPicker: async (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_FOLDER_PICKER),
  ptyDrain: (paneId: string) => ipcRenderer.send(IPC_CHANNELS.PTY_DRAIN, { paneId }),
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
    > => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath),
    write: async (
      filePath: string,
      content: string
    ): Promise<{ success: true } | { success: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, { filePath, content }),
    openDialog: async (opts: { defaultPath?: string } = {}): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_DIALOG, opts),
    list: async (
      dirPath: string
    ): Promise<{
      success: true;
      files: Array<{ path: string; relativePath: string; name: string }>;
    }> => ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, { dirPath }),
    onOpenInTab: (callback: (payload: FileOpenInTabPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.FILE_OPEN_IN_TAB, callback),
    readBinary: async (
      filePath: string
    ): Promise<{ success: boolean; data?: { base64: string; mimeType: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BINARY, filePath),
    stat: async (
      filePath: string
    ): Promise<{
      success: boolean;
      data?: { size: number; modifiedAt: number; mimeType: string };
      error?: string;
    }> => ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, filePath)
  },
  updates: {
    checkForUpdates: async (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
    onUpdateStatus: (callback: (status: import('../shared/types').UpdateStatus) => void) => {
      return onChannel(IPC_CHANNELS.UPDATE_STATUS, callback);
    },
    installUpdate: (): void => ipcRenderer.send(IPC_CHANNELS.UPDATE_INSTALL),
    getVersion: async (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_VERSION)
  }
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
