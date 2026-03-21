import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
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
  HostContextPayload,
  AdmiralStateDetailPayload,
  StarbaseRuntimeStatus,
  SystemDepResult,
  CreateTabPayload,
  FileOpenInTabPayload
} from '../shared/ipc-api'
import type { Workspace, FleetSettings } from '../shared/types'

type Unsubscribe = () => void

function onChannel<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const hostContext = await ipcRenderer.invoke(
  IPC_CHANNELS.APP_HOST_CONTEXT_GET
) as HostContextPayload

const fleetApi = {
  pty: {
    create: (req: PtyCreateRequest): Promise<PtyCreateResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_CREATE, req),
    input: (payload: PtyInputPayload): void => ipcRenderer.send(IPC_CHANNELS.PTY_INPUT, payload),
    resize: (payload: PtyResizePayload): void => ipcRenderer.send(IPC_CHANNELS.PTY_RESIZE, payload),
    kill: (paneId: string): void => ipcRenderer.send(IPC_CHANNELS.PTY_KILL, paneId),
    gc: (activePaneIds: string[]): void => ipcRenderer.send(IPC_CHANNELS.PTY_GC, activePaneIds),
    attach: (paneId: string): Promise<{ data: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PTY_ATTACH, { paneId }),
    onData: (callback: (payload: PtyDataPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_DATA, callback),
    onExit: (callback: (payload: PtyExitPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_EXIT, callback),
    onCwd: (callback: (payload: PtyCwdPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PTY_CWD, callback)
  },
  layout: {
    save: (req: LayoutSaveRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SAVE, req),
    load: (workspaceId: string): Promise<Workspace> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD, workspaceId),
    list: (): Promise<LayoutListResponse> => ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LIST),
    delete: (workspaceId: string): Promise<void> =>
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
  homeDir: hostContext.homeDir,
  platform: hostContext.platform,
  utils: {
    getFilePath: (file: File): string => webUtils.getPathForFile(file)
  },
  settings: {
    get: (): Promise<FleetSettings> => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: (settings: Partial<FleetSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings)
  },
  git: {
    isRepo: (cwd: string): Promise<GitIsRepoPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_IS_REPO, cwd),
    getStatus: (cwd: string): Promise<GitStatusPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd)
  },
  admiral: {
    checkDependencies: (): Promise<SystemDepResult[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_CHECK_DEPENDENCIES),
    getPaneId: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_PANE_ID),
    ensureStarted: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_ENSURE_STARTED),
    restart: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_RESTART),
    reset: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_RESET),
    onStatusChanged: (callback: (payload: AdmiralStatusPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, callback),
    onStateDetail: (callback: (payload: AdmiralStateDetailPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, callback),
  },
  starbase: {
    getRuntimeStatus: (): Promise<StarbaseRuntimeStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_GET),
    retryRuntimeBootstrap: (): Promise<StarbaseRuntimeStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_RETRY),
    onRuntimeStatus: (callback: (payload: StarbaseRuntimeStatus) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_CHANGED, callback),
    listSectors: (): Promise<unknown[]> => ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_SECTORS),
    listCrew: (filter?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CREW, filter),
    listMissions: (filter?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MISSIONS, filter),
    getUnreadComms: (): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_COMMS_UNREAD),
    listComms: (opts?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_COMMS, opts),
    markCommsRead: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MARK_COMMS_READ, { id }),
    resolveComms: (id: number, response: string): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RESOLVE_COMMS, { id, response }),
    deleteComms: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_DELETE_COMMS, { id }),
    markAllCommsRead: (): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MARK_ALL_COMMS_READ),
    clearComms: (): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CLEAR_COMMS),
    deployCrew: (opts: unknown): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_DEPLOY, opts),
    recallCrew: (crewId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RECALL, { crewId }),
    observeCrew: (crewId: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_OBSERVE, { crewId }),
    messageCrew: (crewId: string, message: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MESSAGE_CREW, { crewId, message }),
    addMission: (req: unknown): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_ADD_MISSION, req),
    onStatusUpdate: (callback: (payload: unknown) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_STATUS_UPDATE, callback),
    listSupplyRoutes: (opts?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_SUPPLY_ROUTES, opts),
    addSupplyRoute: (opts: unknown): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_ADD_SUPPLY_ROUTE, opts),
    removeSupplyRoute: (routeId: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_REMOVE_SUPPLY_ROUTE, { routeId }),
    getSupplyRouteGraph: (): Promise<Record<string, string[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_SUPPLY_ROUTE_GRAPH),
    listCargo: (filter?: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_CARGO, filter),
    getRetentionStats: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RETENTION_STATS),
    retentionCleanup: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RETENTION_CLEANUP),
    retentionVacuum: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_RETENTION_VACUUM),
    getConfig: (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_GET_CONFIG),
    setConfig: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_SET_CONFIG, { key, value }),
    addSector: (opts: unknown): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_ADD_SECTOR, opts),
    removeSector: (sectorId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, { sectorId }),
    updateSector: (sectorId: string, fields: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, { sectorId, fields }),
    memoList: (): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_LIST),
    memoRead: (id: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_READ, id),
    memoDismiss: (id: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_DISMISS, id),
    memoContent: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.MEMO_CONTENT, filePath),
    getShipsLog: (opts?: { limit?: number }): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.STARBASE_SHIPS_LOG, opts),
    onLogEntry: (callback: (entry: unknown) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.STARBASE_LOG_ENTRY, callback),
  },
  system: {
    check: (): Promise<import('../shared/ipc-api').SystemDepResult[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_CHECK),
  },
  showFolderPicker: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_FOLDER_PICKER),
  ptyDrain: (paneId: string) => ipcRenderer.send(IPC_CHANNELS.PTY_DRAIN, { paneId }),
  // TODO(#30): Crew tabs are no longer created — crews are now headless (stream-json).
  // This bridge remains for backwards compatibility but will not fire for new deployments.
  onCreateTab: (callback: (payload: CreateTabPayload) => void): Unsubscribe => {
    const cleanup = onChannel('fleet:create-tab', callback)
    // Signal to main that the renderer is ready to receive create-tab messages
    ipcRenderer.send('fleet:create-tab-ready')
    return cleanup
  },
  file: {
    read: (
      filePath: string
    ): Promise<
      | { success: true; data: { content: string; size: number; modifiedAt: number } }
      | { success: false; error: string }
    > =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath),
    write: (
      filePath: string,
      content: string
    ): Promise<{ success: true } | { success: false; error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, { filePath, content }),
    openDialog: (opts: { defaultPath?: string } = {}): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_DIALOG, opts),
    list: (
      dirPath: string
    ): Promise<{ success: true; files: Array<{ path: string; relativePath: string; name: string }> }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, { dirPath }),
    onOpenInTab: (callback: (payload: FileOpenInTabPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.FILE_OPEN_IN_TAB, callback),
    readBinary: (filePath: string): Promise<{ success: boolean; data?: { base64: string; mimeType: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BINARY, filePath),
    stat: (filePath: string): Promise<{ success: boolean; data?: { size: number; modifiedAt: number; mimeType: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, filePath),
  },
  updates: {
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
    onUpdateStatus: (callback: (status: import('../shared/types').UpdateStatus) => void) => {
      return onChannel(IPC_CHANNELS.UPDATE_STATUS, callback)
    },
    installUpdate: (): void => ipcRenderer.send(IPC_CHANNELS.UPDATE_INSTALL),
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.GET_VERSION)
  }
}

contextBridge.exposeInMainWorld('fleet', fleetApi)

export type FleetApi = typeof fleetApi
