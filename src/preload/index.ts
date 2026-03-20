import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { homedir } from 'os'
import { IPC_CHANNELS } from '../shared/constants'
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
  AdmiralStateDetailPayload
} from '../shared/ipc-api'
import type { Workspace, FleetSettings } from '../shared/types'

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
    onData: (callback: (payload: PtyDataPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyDataPayload) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler)
    },
    onExit: (callback: (payload: PtyExitPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyExitPayload) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.PTY_EXIT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_EXIT, handler)
    },
    onCwd: (callback: (payload: PtyCwdPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PtyCwdPayload) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.PTY_CWD, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PTY_CWD, handler)
    }
  },
  layout: {
    save: (req: LayoutSaveRequest): void =>
      ipcRenderer.sendSync(IPC_CHANNELS.LAYOUT_SAVE, req),
    load: (workspaceId: string): Promise<Workspace> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD, workspaceId),
    list: (): Promise<LayoutListResponse> => ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LIST),
    delete: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_DELETE, workspaceId)
  },
  notifications: {
    onNotification: (callback: (payload: NotificationPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: NotificationPayload) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.NOTIFICATION, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION, handler)
    },
    paneFocused: (payload: PaneFocusedPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.PANE_FOCUSED, payload)
  },
  agentState: {
    onStateUpdate: (callback: (payload: AgentStatePayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentStatePayload) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.AGENT_STATE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATE, handler)
    }
  },
  homeDir: homedir(),
  platform: process.platform,
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
    checkDependencies: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_CHECK_DEPENDENCIES),
    getPaneId: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_PANE_ID),
    ensureStarted: (): Promise<string | null> => ipcRenderer.invoke('admiral:ensure-started'),
    restart: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_RESTART),
    reset: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_RESET),
    onStatusChanged: (callback: (payload: { status: string; paneId: string | null; error?: string; exitCode?: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { status: string; paneId: string | null; error?: string; exitCode?: number }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, handler)
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, handler) }
    },
    onStateDetail: (callback: (payload: AdmiralStateDetailPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AdmiralStateDetailPayload) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, handler)
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, handler) }
    },
  },
  starbase: {
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
    onStatusUpdate: (callback: (payload: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.STARBASE_STATUS_UPDATE, handler)
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.STARBASE_STATUS_UPDATE, handler) }
    },
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
  onCreateTab: (callback: (payload: { tabId: string; label: string; cwd: string; avatarVariant?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { tabId: string; label: string; cwd: string; avatarVariant?: string }) =>
      callback(payload)
    ipcRenderer.on('fleet:create-tab', handler)
    // Signal to main that the renderer is ready to receive create-tab messages
    ipcRenderer.send('fleet:create-tab-ready')
    return () => ipcRenderer.removeListener('fleet:create-tab', handler)
  },
  file: {
    read: (filePath: string): Promise<{ content: string } | { error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath),
    write: (filePath: string, content: string): Promise<{ success: boolean } | { error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, { filePath, content }),
    stat: (filePath: string): Promise<{ size: number; mtime: number } | { error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, filePath),
    readBinary: (filePath: string): Promise<{ data: string; mimeType: string } | { error: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BINARY, filePath),
    openDialog: (opts: { defaultPath?: string } = {}): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_DIALOG, opts),
    onOpenInTab: (callback: (payload: { files: Array<{ path: string; paneType: 'file' | 'image'; label: string }> }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { files: Array<{ path: string; paneType: 'file' | 'image'; label: string }> }) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.FILE_OPEN_IN_TAB, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_OPEN_IN_TAB, handler)
    },
    readBinary: (filePath: string): Promise<{ success: boolean; data?: { base64: string; mimeType: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BINARY, filePath),
    stat: (filePath: string): Promise<{ success: boolean; data?: { size: number; modifiedAt: number; mimeType: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, filePath),
  },
  updates: {
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke('fleet:update-check'),
    onUpdateStatus: (callback: (status: import('../shared/types').UpdateStatus) => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        status: import('../shared/types').UpdateStatus
      ) => callback(status)
      ipcRenderer.on('fleet:update-status', handler)
      return () => ipcRenderer.removeListener('fleet:update-status', handler)
    },
    installUpdate: (): void => ipcRenderer.send('fleet:install-update'),
    getVersion: (): Promise<string> => ipcRenderer.invoke('fleet:get-version')
  }
}

contextBridge.exposeInMainWorld('fleet', fleetApi)

export type FleetApi = typeof fleetApi
