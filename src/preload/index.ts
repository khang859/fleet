import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
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
  GitStatusPayload,
  GitIsRepoPayload,
  HostPlatform,
  FileOpenInTabPayload,
  ReaddirResponse,
  FileSearchRequest,
  FileSearchResponse,
  RecentImagesResponse,
  ClipboardHistoryResponse,
  LogEntry,
  ActivityStatePayload,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
  WorktreeRemoveRequest
} from '../shared/ipc-api';
import type {
  Workspace,
  FleetSettings,
  UpdateStatus,
  ImageGenerationMeta,
  ImageSettings
} from '../shared/types';

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
      ipcRenderer.send(IPC_CHANNELS.PANE_FOCUSED, payload),
    onFocusPane: (callback: (payload: { paneId: string }) => void): Unsubscribe =>
      onChannel('fleet:focus-pane', callback),
  },
  activity: {
    onStateChange: (callback: (payload: ActivityStatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ACTIVITY_STATE, callback),
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
  worktree: {
    create: async (req: WorktreeCreateRequest): Promise<WorktreeCreateResponse> =>
      typedInvoke(IPC_CHANNELS.WORKTREE_CREATE, req),
    remove: async (req: WorktreeRemoveRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.WORKTREE_REMOVE, req),
  },
  showFolderPicker: async (): Promise<string | null> =>
    typedInvoke(IPC_CHANNELS.SHOW_FOLDER_PICKER),
  ptyDrain: (paneId: string) => {
    if (pausedPanes.has(paneId)) {
      pausedPanes.delete(paneId);
      ipcRenderer.send(IPC_CHANNELS.PTY_DRAIN, { paneId });
    }
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
      typedInvoke(IPC_CHANNELS.FILE_SEARCH, req),
    searchRecentImages: async (): Promise<RecentImagesResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_RECENT_IMAGES)
  },
  clipboard: {
    getHistory: async (): Promise<ClipboardHistoryResponse> =>
      typedInvoke(IPC_CHANNELS.CLIPBOARD_HISTORY),
    onChanged: (callback: (payload: ClipboardHistoryResponse) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.CLIPBOARD_CHANGED, callback)
  },
  updates: {
    checkForUpdates: async (): Promise<void> => typedInvoke(IPC_CHANNELS.UPDATE_CHECK),
    onUpdateStatus: (callback: (status: UpdateStatus) => void): Unsubscribe => {
      return onChannel(IPC_CHANNELS.UPDATE_STATUS, callback);
    },
    installUpdate: (): void => ipcRenderer.send(IPC_CHANNELS.UPDATE_INSTALL),
    getVersion: async (): Promise<string> => typedInvoke(IPC_CHANNELS.GET_VERSION)
  },
  images: {
    generate: async (opts: {
      prompt: string;
      provider?: string;
      model?: string;
      resolution?: string;
      aspectRatio?: string;
      outputFormat?: string;
      numImages?: number;
    }): Promise<{ id: string }> => typedInvoke(IPC_CHANNELS.IMAGES_GENERATE, opts),
    edit: async (opts: {
      prompt: string;
      images: string[];
      provider?: string;
      model?: string;
      resolution?: string;
      aspectRatio?: string;
      outputFormat?: string;
      numImages?: number;
    }): Promise<{ id: string }> => typedInvoke(IPC_CHANNELS.IMAGES_EDIT, opts),
    getStatus: async (id: string): Promise<ImageGenerationMeta | null> =>
      typedInvoke(IPC_CHANNELS.IMAGES_STATUS, id),
    list: async (): Promise<ImageGenerationMeta[]> => typedInvoke(IPC_CHANNELS.IMAGES_LIST),
    retry: async (id: string): Promise<{ id: string }> =>
      typedInvoke(IPC_CHANNELS.IMAGES_RETRY, id),
    delete: async (id: string): Promise<void> => typedInvoke(IPC_CHANNELS.IMAGES_DELETE, id),
    getConfig: async (): Promise<ImageSettings> => typedInvoke(IPC_CHANNELS.IMAGES_CONFIG_GET),
    setConfig: async (partial: Partial<ImageSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.IMAGES_CONFIG_SET, partial),
    onChanged: (callback: (payload: { id: string }) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.IMAGES_CHANGED, callback),
    runAction: async (opts: {
      actionType: string;
      source: string;
      provider?: string;
    }): Promise<{ id: string }> => typedInvoke(IPC_CHANNELS.IMAGES_RUN_ACTION, opts),
    listActions: async (provider?: string): Promise<Array<{
      id: string;
      actionType: string;
      provider: string;
      name: string;
      description: string;
      model: string;
    }>> => typedInvoke(IPC_CHANNELS.IMAGES_LIST_ACTIONS, provider)
  },
  shell: {
    openExternal: async (url: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url)
  },
  log: {
    batch: (entries: LogEntry[]): void => ipcRenderer.send(IPC_CHANNELS.LOG_BATCH, entries)
  },
  copilot: {
    notifyActiveWorkspace: (workspaceId: string, workspaceName: string): void =>
      ipcRenderer.send(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, { workspaceId, workspaceName }),
  }
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
