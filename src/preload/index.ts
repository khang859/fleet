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
  GitRepoRootPayload,
  HostPlatform,
  FileOpenInTabPayload,
  ReaddirResponse,
  FileSearchRequest,
  FileSearchResponse,
  FileGrepRequest,
  FileGrepResponse,
  RecentImagesResponse,
  ClipboardHistoryResponse,
  LogEntry,
  DiagnosticsInfo,
  ActivityStatePayload,
  ActivityReportPayload,
  RemoteStatePayload,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
  WorktreeRemoveRequest,
  ShellProfilesListResponse,
  WslStatusResponse,
  WslPathResponse,
  WslHomeDirResponse
} from '../shared/ipc-api';
import type { WslDistroState, PathContext } from '../shared/shell-profiles';
import type {
  Workspace,
  FleetSettings,
  FleetSettingsPatch,
  UpdateStatus,
  AnnotationMeta
} from '../shared/types';
import type {
  EnvSyncConfig,
  ConflictChoice,
  BucketCreateResult,
  EnvSyncSetPassphraseRequest,
  EnvSyncClearPassphraseRequest,
  EnvSyncSetAuthRequest,
  EnvSyncClearAuthRequest,
  DiscoveredRepo,
  TargetStatus,
  SyncOutcome,
  RedactedEnvSyncSecrets
} from '../shared/ipc-api';
import type {
  EnvFileEntry,
  EnvReadResult,
  EnvWriteResult,
  EnvPathResult,
  EnvTrashResult
} from '../shared/env-editor-types';
import type { NoteReadResult, NoteWriteResult } from '../shared/notes-types';
import type {
  AgentAttachRequest,
  AgentAttachResult,
  AgentCatalog,
  AgentCompactDone,
  AgentCompactRequest,
  AgentHandOff,
  AgentImagePartial,
  AgentMentionMatch,
  AgentPermissionAsk,
  AgentPermissionDecision,
  AgentSendRequest,
  AgentStreamDelta,
  AgentStreamDone,
  AgentStreamError,
  AgentTaskDone,
  AgentTaskStart,
  AgentTitleRequest,
  AgentTitleResult,
  AgentToolEvent
} from '../shared/agent-types';
import type { AgentCommandDescriptor } from '../shared/agent-commands';
import type {
  FoundSkill,
  InstalledSkill,
  SkillFetchResult,
  SkillInstallOutcome
} from '../shared/agent-skill-install';
import type {
  AgentSessionAddSpend,
  AgentSessionAppend,
  AgentSessionListItem,
  AgentSessionReplay
} from '../shared/agent-session';
import type { AgentGitHeadEvent } from '../shared/agent-git';
// Aliased so the generic MCP names read as the Agent pane's at every use site.
import type {
  McpDetectedServer as AgentMcpDetected,
  McpServersConfig as AgentMcpServers,
  McpServerStatus as AgentMcpStatus,
  McpSnapshot as AgentMcpSnapshot
} from '../shared/agent-mcp';
import type {
  DetectedSshHost,
  RemoteDirEntry,
  RemoteFetchResult,
  RemoteHost,
  RemoteListResult,
  RemoteResult,
  RemoteTextResult,
  RemoteTransfer,
  RemoteTransferRequest
} from '../shared/remote-ssh-types';
import type { ShellEnvSnapshot } from '../shared/shell-env-types';
import type { SessionSummary, SessionTranscript } from '../shared/sessions';
import type {
  Learning,
  CreateLearningInput,
  UpdateLearningInput,
  LearningSearchFilter,
  DistillRequest,
  DistillResult,
  TagCount,
  LearningsStatus
} from '../shared/learnings';

type Unsubscribe = () => void;

// Typed wrapper for ipcRenderer.invoke to avoid unsafe-return at every IPC call site.
// The cast is safe: callers declare the return type, and main process implements it.
// eslint-disable-next-line @typescript-eslint/promise-function-async
function typedInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
      onChannel(IPC_CHANNELS.PTY_CWD, callback),
    resolveCwd: async (paneId: string, pathContext?: PathContext): Promise<string | null> =>
      typedInvoke(IPC_CHANNELS.PTY_RESOLVE_CWD, paneId, pathContext)
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
      onChannel('fleet:focus-pane', callback)
  },
  activity: {
    onStateChange: (callback: (payload: ActivityStatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ACTIVITY_STATE, callback),
    /** Tell main what the user can see, so it can judge how loudly to say things. */
    visiblePanes: (paneIds: string[]): void =>
      ipcRenderer.send(IPC_CHANNELS.ACTIVITY_VISIBLE_PANES, paneIds),
    /** Report a pane that has no process for main to watch. */
    report: (payload: ActivityReportPayload): void =>
      ipcRenderer.send(IPC_CHANNELS.ACTIVITY_REPORT, payload),
    onChime: (callback: () => void): Unsubscribe => onChannel(IPC_CHANNELS.ACTIVITY_CHIME, callback)
  },
  ai: {
    summarizePane: async (paneId: string, tailText: string): Promise<string> =>
      typedInvoke(IPC_CHANNELS.AI_SUMMARIZE_PANE, { paneId, tailText })
  },
  remote: {
    onStateChange: (callback: (payload: RemoteStatePayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.REMOTE_STATE, callback)
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
    set: async (settings: FleetSettingsPatch): Promise<void> =>
      typedInvoke(IPC_CHANNELS.SETTINGS_SET, settings)
  },
  git: {
    isRepo: async (cwd: string, pathContext?: PathContext): Promise<GitIsRepoPayload> =>
      typedInvoke(IPC_CHANNELS.GIT_IS_REPO, cwd, pathContext),
    repoRoot: async (cwd: string, pathContext?: PathContext): Promise<GitRepoRootPayload> =>
      typedInvoke(IPC_CHANNELS.GIT_REPO_ROOT, cwd, pathContext),
    getStatus: async (
      cwd: string,
      baseRef?: string,
      pathContext?: PathContext
    ): Promise<GitStatusPayload> => typedInvoke(IPC_CHANNELS.GIT_STATUS, cwd, baseRef, pathContext)
  },
  worktree: {
    create: async (req: WorktreeCreateRequest): Promise<WorktreeCreateResponse> =>
      typedInvoke(IPC_CHANNELS.WORKTREE_CREATE, req),
    remove: async (req: WorktreeRemoveRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.WORKTREE_REMOVE, req)
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
      filePath: string,
      pathContext?: PathContext
    ): Promise<
      | { success: true; data: { content: string; size: number; modifiedAt: number } }
      | { success: false; error: string }
    > => typedInvoke(IPC_CHANNELS.FILE_READ, filePath, pathContext),
    write: async (
      filePath: string,
      content: string,
      pathContext?: PathContext
    ): Promise<{ success: true } | { success: false; error: string }> =>
      typedInvoke(IPC_CHANNELS.FILE_WRITE, { filePath, content, pathContext }),
    openDialog: async (
      opts: {
        defaultPath?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        multi?: boolean;
      } = {}
    ): Promise<string[]> => typedInvoke(IPC_CHANNELS.FILE_OPEN_DIALOG, opts),
    /** Picks a destination path. Returns null if the user cancelled. */
    saveDialog: async (
      opts: { defaultName?: string; defaultPath?: string } = {}
    ): Promise<string | null> => typedInvoke(IPC_CHANNELS.FILE_SAVE_DIALOG, opts),
    list: async (
      dirPath: string,
      pathContext?: PathContext
    ): Promise<{
      success: true;
      files: Array<{ path: string; relativePath: string; name: string }>;
    }> => typedInvoke(IPC_CHANNELS.FILE_LIST, { dirPath, pathContext }),
    readdir: async (dirPath: string, pathContext?: PathContext): Promise<ReaddirResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_READDIR, { dirPath, pathContext }),
    onOpenInTab: (callback: (payload: FileOpenInTabPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.FILE_OPEN_IN_TAB, callback),
    readBinary: async (
      filePath: string,
      pathContext?: PathContext
    ): Promise<{ success: boolean; data?: { base64: string; mimeType: string }; error?: string }> =>
      typedInvoke(IPC_CHANNELS.FILE_READ_BINARY, filePath, pathContext),
    stat: async (
      filePath: string,
      pathContext?: PathContext
    ): Promise<{
      success: boolean;
      data?: { size: number; modifiedAt: number; mimeType: string };
      error?: string;
    }> => typedInvoke(IPC_CHANNELS.FILE_STAT, filePath, pathContext),
    search: async (req: FileSearchRequest): Promise<FileSearchResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_SEARCH, req),
    grep: async (req: FileGrepRequest): Promise<FileGrepResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_GREP, req),
    searchRecentImages: async (pathContext?: PathContext): Promise<RecentImagesResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_RECENT_IMAGES, { pathContext }),
    scanImageFolder: async (folderPath: string): Promise<string[]> =>
      typedInvoke(IPC_CHANNELS.FILE_SCAN_IMAGE_FOLDER, { folderPath }),
    checkIgnored: async (dirPath: string, pathContext?: PathContext): Promise<string[]> =>
      typedInvoke(IPC_CHANNELS.FILE_CHECK_IGNORED, { dirPath, pathContext })
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
  shell: {
    openExternal: async (url: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url)
  },
  diagnostics: {
    getInfo: async (): Promise<DiagnosticsInfo> => typedInvoke(IPC_CHANNELS.DIAGNOSTICS_GET_INFO),
    getLogTail: async (maxBytes?: number): Promise<string> =>
      typedInvoke(IPC_CHANNELS.DIAGNOSTICS_GET_LOG_TAIL, maxBytes),
    openLogsFolder: async (): Promise<void> => typedInvoke(IPC_CHANNELS.DIAGNOSTICS_OPEN_LOGS)
  },
  terminal: {
    showContextMenu: async (params: {
      hasSelection: boolean;
    }): Promise<{ action: string | null }> =>
      typedInvoke(IPC_CHANNELS.TERMINAL_CONTEXT_MENU, params)
  },
  log: {
    batch: (entries: LogEntry[]): void => ipcRenderer.send(IPC_CHANNELS.LOG_BATCH, entries)
  },
  copilot: {
    serviceStatus: async (): Promise<{ hookInstalled: boolean; claudeDetected: boolean }> =>
      typedInvoke(IPC_CHANNELS.COPILOT_SERVICE_STATUS),
    installHooks: async (): Promise<boolean> => typedInvoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS),
    uninstallHooks: async (): Promise<boolean> => typedInvoke(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS),
    installHooksTo: async (configDir: string): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, configDir),
    uninstallHooksFrom: async (configDir: string): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS_FROM, configDir),
    hookStatusFor: async (configDir: string): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, configDir),
    notifyActiveWorkspace: (workspaceId: string, workspaceName: string): void =>
      ipcRenderer.send(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, { workspaceId, workspaceName })
  },
  annotate: {
    list: async (): Promise<AnnotationMeta[]> =>
      typedInvoke<AnnotationMeta[]>(IPC_CHANNELS.ANNOTATE_LIST),
    get: async (id: string): Promise<unknown> =>
      typedInvoke<unknown>(IPC_CHANNELS.ANNOTATE_GET, id),
    delete: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.ANNOTATE_DELETE, id),
    start: async (args: {
      url?: string;
      timeout?: number;
      mode?: string;
    }): Promise<{ resultPath: string }> =>
      typedInvoke<{ resultPath: string }>(IPC_CHANNELS.ANNOTATE_UI_START, args),
    onCompleted: (callback: () => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.ANNOTATE_COMPLETED, callback)
  },
  shellProfiles: {
    list: async (): Promise<ShellProfilesListResponse> =>
      typedInvoke<ShellProfilesListResponse>(IPC_CHANNELS.SHELL_PROFILES_LIST)
  },
  wsl: {
    status: async (distro: string): Promise<WslDistroState> => {
      const res = await typedInvoke<WslStatusResponse>(IPC_CHANNELS.WSL_STATUS, { distro });
      return res.state;
    },
    toWslPath: async (distro: string, path: string): Promise<string> => {
      const res = await typedInvoke<WslPathResponse>(IPC_CHANNELS.WSL_TO_WSL_PATH, {
        distro,
        path
      });
      return res.translated;
    },
    toWinPath: async (distro: string, path: string): Promise<string> => {
      const res = await typedInvoke<WslPathResponse>(IPC_CHANNELS.WSL_TO_WIN_PATH, {
        distro,
        path
      });
      return res.translated;
    },
    homeDir: async (distro: string): Promise<string> => {
      const res = await typedInvoke<WslHomeDirResponse>(IPC_CHANNELS.WSL_HOME_DIR, { distro });
      return res.homeDir;
    }
  },
  envSync: {
    getConfig: async (repoDir: string): Promise<EnvSyncConfig | null> =>
      typedInvoke<EnvSyncConfig | null>(IPC_CHANNELS.ENV_SYNC_GET_CONFIG, repoDir),
    discover: async (cwd: string, pathContext?: PathContext): Promise<DiscoveredRepo | null> =>
      typedInvoke<DiscoveredRepo | null>(IPC_CHANNELS.ENV_SYNC_DISCOVER, cwd, pathContext),
    writeConfig: async (repoDir: string, config: EnvSyncConfig): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.ENV_SYNC_WRITE_CONFIG, repoDir, config),
    scan: async (repoDir: string): Promise<string[]> =>
      typedInvoke<string[]>(IPC_CHANNELS.ENV_SYNC_SCAN, repoDir),
    status: async (repoDir: string): Promise<TargetStatus[]> =>
      typedInvoke<TargetStatus[]>(IPC_CHANNELS.ENV_SYNC_STATUS, repoDir),
    pull: async (repoDir: string, envFile: string, force: boolean): Promise<SyncOutcome> =>
      typedInvoke<SyncOutcome>(IPC_CHANNELS.ENV_SYNC_PULL, repoDir, envFile, force),
    push: async (repoDir: string, envFile: string, force: boolean): Promise<SyncOutcome> =>
      typedInvoke<SyncOutcome>(IPC_CHANNELS.ENV_SYNC_PUSH, repoDir, envFile, force),
    resolve: async (
      repoDir: string,
      envFile: string,
      choice: ConflictChoice
    ): Promise<SyncOutcome> =>
      typedInvoke<SyncOutcome>(IPC_CHANNELS.ENV_SYNC_RESOLVE, repoDir, envFile, choice),
    diff: async (repoDir: string, envFile: string): Promise<SyncOutcome> =>
      typedInvoke<SyncOutcome>(IPC_CHANNELS.ENV_SYNC_DIFF, repoDir, envFile),
    createBucket: async (repoDir: string): Promise<BucketCreateResult> =>
      typedInvoke<BucketCreateResult>(IPC_CHANNELS.ENV_SYNC_CREATE_BUCKET, repoDir),
    getSecrets: async (): Promise<RedactedEnvSyncSecrets> =>
      typedInvoke<RedactedEnvSyncSecrets>(IPC_CHANNELS.ENV_SYNC_GET_SECRETS),
    setPassphrase: async (req: EnvSyncSetPassphraseRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.ENV_SYNC_SET_PASSPHRASE, req),
    clearPassphrase: async (req: EnvSyncClearPassphraseRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.ENV_SYNC_CLEAR_PASSPHRASE, req),
    setAuth: async (req: EnvSyncSetAuthRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.ENV_SYNC_SET_AUTH, req),
    clearAuth: async (req: EnvSyncClearAuthRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.ENV_SYNC_CLEAR_AUTH, req),
    encryptionAvailable: async (): Promise<{ available: boolean; backend?: string }> =>
      typedInvoke<{ available: boolean; backend?: string }>(
        IPC_CHANNELS.ENV_SYNC_ENCRYPTION_AVAILABLE
      )
  },
  envEditor: {
    list: async (root: string, pathContext?: PathContext): Promise<EnvFileEntry[]> =>
      typedInvoke<EnvFileEntry[]>(IPC_CHANNELS.ENV_EDITOR_LIST, root, pathContext),
    read: async (absPath: string): Promise<EnvReadResult> =>
      typedInvoke<EnvReadResult>(IPC_CHANNELS.ENV_EDITOR_READ, absPath),
    write: async (
      absPath: string,
      text: string,
      expectedMtimeMs?: number
    ): Promise<EnvWriteResult> =>
      typedInvoke<EnvWriteResult>(IPC_CHANNELS.ENV_EDITOR_WRITE, absPath, text, expectedMtimeMs),
    create: async (dir: string, name: string, pathContext?: PathContext): Promise<EnvPathResult> =>
      typedInvoke<EnvPathResult>(IPC_CHANNELS.ENV_EDITOR_CREATE, dir, name, pathContext),
    rename: async (absPath: string, newName: string): Promise<EnvPathResult> =>
      typedInvoke<EnvPathResult>(IPC_CHANNELS.ENV_EDITOR_RENAME, absPath, newName),
    delete: async (absPath: string): Promise<EnvTrashResult> =>
      typedInvoke<EnvTrashResult>(IPC_CHANNELS.ENV_EDITOR_DELETE, absPath),
    restore: async (trashPath: string, absPath: string): Promise<{ ok: true }> =>
      typedInvoke<{ ok: true }>(IPC_CHANNELS.ENV_EDITOR_RESTORE, trashPath, absPath)
  },
  notes: {
    read: async (scopePath: string, pathContext?: PathContext): Promise<NoteReadResult> =>
      typedInvoke<NoteReadResult>(IPC_CHANNELS.NOTES_READ, scopePath, pathContext),
    write: async (
      scopePath: string,
      text: string,
      expectedMtimeMs?: number,
      pathContext?: PathContext
    ): Promise<NoteWriteResult> =>
      typedInvoke<NoteWriteResult>(
        IPC_CHANNELS.NOTES_WRITE,
        scopePath,
        text,
        expectedMtimeMs,
        pathContext
      )
  },

  /**
   * Agent panes. Settings live in `settings.ai.agent`; the OpenRouter key is
   * app-wide and write-only from here. The caller mints the stream id and every
   * event carries it.
   */
  agent: {
    listModels: async (refresh = false): Promise<AgentCatalog> =>
      typedInvoke<AgentCatalog>(IPC_CHANNELS.AGENT_LIST_MODELS, refresh),
    setKey: async (key: string): Promise<void> => typedInvoke(IPC_CHANNELS.AGENT_SET_KEY, key),
    hasKey: async (): Promise<boolean> => typedInvoke(IPC_CHANNELS.AGENT_HAS_KEY),
    clearKey: async (): Promise<void> => typedInvoke(IPC_CHANNELS.AGENT_CLEAR_KEY),
    send: (req: AgentSendRequest): void => ipcRenderer.send(IPC_CHANNELS.AGENT_SEND, req),
    compact: (req: AgentCompactRequest): void => ipcRenderer.send(IPC_CHANNELS.AGENT_COMPACT, req),
    cancel: (streamId: string): void => ipcRenderer.send(IPC_CHANNELS.AGENT_CANCEL, streamId),
    onStreamChunk: (cb: (p: AgentStreamDelta) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_STREAM_CHUNK, cb),
    onStreamReasoning: (cb: (p: AgentStreamDelta) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_STREAM_REASONING, cb),
    onStreamDone: (cb: (p: AgentStreamDone) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_STREAM_DONE, cb),
    onStreamError: (cb: (p: AgentStreamError) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_STREAM_ERROR, cb),
    onCompactDone: (cb: (p: AgentCompactDone) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_COMPACT_DONE, cb),
    onToolStart: (cb: (p: AgentToolEvent) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_TOOL_START, cb),
    onToolEnd: (cb: (p: AgentToolEvent) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_TOOL_END, cb),
    /** A render on the way to a finished image. May never fire. */
    onImagePartial: (cb: (p: AgentImagePartial) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_IMAGE_PARTIAL, cb),
    onHandOff: (cb: (p: AgentHandOff) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_HAND_OFF, cb),
    onPermissionAsk: (cb: (p: AgentPermissionAsk) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_PERMISSION_ASK, cb),
    decidePermission: (req: AgentPermissionDecision): void =>
      ipcRenderer.send(IPC_CHANNELS.AGENT_PERMISSION_DECIDE, req),
    /**
     * A subagent starting, and later ending. Addressed by thread rather than by
     * stream, because the turn that dispatched it is over by the time it ends.
     */
    onTaskStart: (cb: (p: AgentTaskStart) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_TASK_START, cb),
    onTaskDone: (cb: (p: AgentTaskDone) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_TASK_DONE, cb),
    /** The child's own transcript, read when its card is opened. */
    taskTranscript: async (taskId: string): Promise<AgentSessionReplay> =>
      typedInvoke<AgentSessionReplay>(IPC_CHANNELS.AGENT_TASK_TRANSCRIPT, taskId),
    cancelTask: (taskId: string): void => ipcRenderer.send(IPC_CHANNELS.AGENT_TASK_CANCEL, taskId),
    /** Which of these are still running, for a pane that has just replayed. */
    runningTasks: async (taskIds: string[]): Promise<string[]> =>
      typedInvoke<string[]>(IPC_CHANNELS.AGENT_TASK_RUNNING, taskIds),
    /** Fire-and-forget: a failed write must not stall the turn that caused it. */
    appendSession: (req: AgentSessionAppend): void =>
      ipcRenderer.send(IPC_CHANNELS.AGENT_SESSION_APPEND, req),
    /** The same, for a bill a session has to add to its own total. */
    addSessionSpend: (req: AgentSessionAddSpend): void =>
      ipcRenderer.send(IPC_CHANNELS.AGENT_SESSION_ADD_SPEND, req),
    loadSession: async (sessionId: string): Promise<AgentSessionReplay> =>
      typedInvoke<AgentSessionReplay>(IPC_CHANNELS.AGENT_SESSION_LOAD, sessionId),
    listSessions: async (cwd: string): Promise<AgentSessionListItem[]> =>
      typedInvoke<AgentSessionListItem[]>(IPC_CHANNELS.AGENT_SESSION_LIST, cwd),
    deleteSession: async (sessionId: string): Promise<boolean> =>
      typedInvoke<boolean>(IPC_CHANNELS.AGENT_SESSION_DELETE, sessionId),
    /**
     * A `null` title means nothing usable came back and the caller keeps its
     * own fallback - but the call still has its cost to report, which is why
     * this is a pair rather than a name.
     */
    generateTitle: async (req: AgentTitleRequest): Promise<AgentTitleResult> =>
      typedInvoke<AgentTitleResult>(IPC_CHANNELS.AGENT_GENERATE_TITLE, req),
    /** Refusals come back in the result, so the composer can say why. */
    attach: async (req: AgentAttachRequest): Promise<AgentAttachResult> =>
      typedInvoke<AgentAttachResult>(IPC_CHANNELS.AGENT_ATTACH, req),
    mentionSearch: async (query: string, cwd: string): Promise<AgentMentionMatch[]> =>
      typedInvoke<AgentMentionMatch[]>(IPC_CHANNELS.AGENT_MENTION_SEARCH, query, cwd),
    /**
     * The `/` menu's rows. Names and descriptions only - the prompt behind a
     * command stays in main, which is the side that sends it.
     */
    commandsList: async (cwd: string): Promise<AgentCommandDescriptor[]> =>
      typedInvoke<AgentCommandDescriptor[]>(IPC_CHANNELS.AGENT_COMMANDS_LIST, cwd),
    /**
     * Which branch the pane's folder is on. Registering answers on `onGitHead`
     * straight away, so there is no separate first read to wait for.
     */
    watchGit: (paneId: string, cwd: string): void =>
      ipcRenderer.send(IPC_CHANNELS.AGENT_GIT_WATCH, paneId, cwd),
    unwatchGit: (paneId: string): void => ipcRenderer.send(IPC_CHANNELS.AGENT_GIT_UNWATCH, paneId),
    /** For a change a watcher cannot see - a tool call that may have checked out. */
    refreshGit: (paneId: string): void => ipcRenderer.send(IPC_CHANNELS.AGENT_GIT_REFRESH, paneId),
    onGitHead: (cb: (p: AgentGitHeadEvent) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.AGENT_GIT_HEAD, cb),
    /**
     * What the composer's Up key walks back through. Asked for once when a pane
     * opens - a hundred short strings, held in the renderer after that, because
     * a keypress that waits on a round trip does not feel like a keypress.
     */
    historyList: async (cwd: string): Promise<string[]> =>
      typedInvoke<string[]>(IPC_CHANNELS.AGENT_HISTORY_LIST, cwd),
    /** Fire-and-forget beside a send: failing to record must not fail the send. */
    historyAdd: (cwd: string, text: string): void =>
      ipcRenderer.send(IPC_CHANNELS.AGENT_HISTORY_ADD, cwd, text),

    /**
     * MCP servers the agent can call tools on.
     *
     * Every call that changes something answers with the whole snapshot, so the
     * pane never has to ask again to find out what its own click did. Nothing
     * here ever carries a credential back: `credentials` says whether one is
     * set, and that is all the renderer is told.
     */
    mcp: {
      get: async (): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_GET),
      set: async (servers: AgentMcpServers): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_SET, servers),
      reconnect: async (name: string): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_RECONNECT, name),
      /** Opens the user's browser and settles when they come back, or rejects. */
      signIn: async (name: string): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_SIGN_IN, name),
      signOut: async (name: string): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_SIGN_OUT, name),
      /** `null` clears it. It never comes back out; only whether one is set does. */
      setToken: async (name: string, token: string | null): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_SET_TOKEN, name, token),
      /** What Claude Code and OpenCode have configured, with their keys removed. */
      detect: async (cwd: string): Promise<AgentMcpDetected[]> =>
        typedInvoke<AgentMcpDetected[]>(IPC_CHANNELS.AGENT_MCP_DETECT, cwd),
      import: async (
        picked: Array<{ name: string; path: string }>,
        cwd: string
      ): Promise<AgentMcpSnapshot> =>
        typedInvoke<AgentMcpSnapshot>(IPC_CHANNELS.AGENT_MCP_IMPORT, picked, cwd),
      /** Pushed whenever a connection changes state, including with nobody asking. */
      onStatus: (cb: (p: AgentMcpStatus[]) => void): Unsubscribe =>
        onChannel(IPC_CHANNELS.AGENT_MCP_STATUS, cb)
    },

    /**
     * Skills: `SKILL.md` folders in the shared agentskills.io format.
     *
     * No `get`/`set` pair, because these are files rather than settings. `list`
     * reads Fleet's own folder, `detect` reads the other tools' folders, `fetch`
     * clones a repository into a temp folder and reports what is in it, and
     * `install` copies chosen folders into Fleet's.
     *
     * `install` takes paths, and main checks each one against the roots it
     * itself offered rather than trusting the list back.
     */
    skills: {
      list: async (): Promise<InstalledSkill[]> =>
        typedInvoke<InstalledSkill[]>(IPC_CHANNELS.AGENT_SKILLS_LIST),
      /** What Claude Code, OpenCode and `~/.agents` already have. */
      detect: async (cwd: string): Promise<FoundSkill[]> =>
        typedInvoke<FoundSkill[]>(IPC_CHANNELS.AGENT_SKILLS_DETECT, cwd),
      /** Rejects with a sentence to show when the clone fails or holds no skills. */
      fetch: async (from: string): Promise<SkillFetchResult> =>
        typedInvoke<SkillFetchResult>(IPC_CHANNELS.AGENT_SKILLS_FETCH, from),
      /** Throw the checkout away, once installed from or abandoned. */
      discard: async (fetchId: string): Promise<void> =>
        typedInvoke<void>(IPC_CHANNELS.AGENT_SKILLS_DISCARD, fetchId),
      install: async (
        picked: Array<{ name: string; path: string }>,
        cwd: string
      ): Promise<SkillInstallOutcome> =>
        typedInvoke<SkillInstallOutcome>(IPC_CHANNELS.AGENT_SKILLS_INSTALL, picked, cwd),
      remove: async (name: string): Promise<void> =>
        typedInvoke<void>(IPC_CHANNELS.AGENT_SKILLS_REMOVE, name),
      /** The way to everything this UI does not do: edit one, look at what it bundles. */
      reveal: async (path: string): Promise<void> =>
        typedInvoke<void>(IPC_CHANNELS.AGENT_SKILLS_REVEAL, path)
    }
  },

  /**
   * Remote (SSH) file browser. Every call returns a `RemoteResult`, so a dropped
   * connection or a permission error arrives as data rather than a rejection.
   */
  remoteSsh: {
    test: async (host: RemoteHost): Promise<RemoteResult<{ ok: boolean; error?: string }>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_TEST, host),
    home: async (host: RemoteHost): Promise<RemoteResult<string>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_HOME, host),
    list: async (host: RemoteHost, path: string): Promise<RemoteResult<RemoteListResult>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_LIST, host, path),
    stat: async (host: RemoteHost, path: string): Promise<RemoteResult<RemoteDirEntry | null>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_STAT, host, path),
    /** Returns a *local* cache path, which is what viewer panes and the
     *  fleet-image:// / fleet-pdf:// protocols consume unchanged. */
    fetch: async (host: RemoteHost, path: string): Promise<RemoteResult<RemoteFetchResult>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_FETCH, host, path),
    readText: async (host: RemoteHost, path: string): Promise<RemoteResult<RemoteTextResult>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_READ_TEXT, host, path),
    writeText: async (
      host: RemoteHost,
      path: string,
      content: string,
      expectedMtimeMs?: number
    ): Promise<RemoteResult<{ ok: true; mtimeMs: number } | { ok: false; externalChange: true }>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_WRITE_TEXT, host, path, content, expectedMtimeMs),
    mkdir: async (host: RemoteHost, path: string): Promise<RemoteResult<void>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_MKDIR, host, path),
    rename: async (host: RemoteHost, from: string, to: string): Promise<RemoteResult<void>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_RENAME, host, from, to),
    remove: async (
      host: RemoteHost,
      path: string,
      isDirectory: boolean
    ): Promise<RemoteResult<void>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_REMOVE, host, path, isDirectory),
    /** Resolves when the bytes have landed; watch `onTransfer` for progress. */
    upload: async (request: RemoteTransferRequest): Promise<RemoteResult<void>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_UPLOAD, request),
    download: async (request: RemoteTransferRequest): Promise<RemoteResult<void>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_DOWNLOAD, request),
    cancelTransfer: async (id: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_TRANSFER_CANCEL, id),
    onTransfer: (callback: (transfer: RemoteTransfer) => void): Unsubscribe =>
      onChannel<RemoteTransfer>(IPC_CHANNELS.REMOTE_SSH_TRANSFER_PROGRESS, callback),
    disconnect: async (host: RemoteHost): Promise<RemoteResult<void>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_DISCONNECT, host),
    detectHost: async (paneId: string): Promise<RemoteResult<DetectedSshHost | null>> =>
      typedInvoke(IPC_CHANNELS.REMOTE_SSH_DETECT_HOST, paneId)
  },
  shellEnv: {
    get: async (paneId: string): Promise<ShellEnvSnapshot | null> =>
      typedInvoke<ShellEnvSnapshot | null>(IPC_CHANNELS.SHELL_ENV_GET, paneId)
  },
  sessions: {
    list: async (): Promise<SessionSummary[]> => typedInvoke(IPC_CHANNELS.SESSIONS_LIST),
    read: async (args: { id: string; cwd: string }): Promise<SessionTranscript | null> =>
      typedInvoke(IPC_CHANNELS.SESSIONS_READ, args),
    onChanged: (callback: () => void): Unsubscribe =>
      onChannel<void>(IPC_CHANNELS.SESSIONS_CHANGED, () => callback())
  },
  learnings: {
    search: async (filter?: LearningSearchFilter): Promise<Learning[]> =>
      typedInvoke<Learning[]>(IPC_CHANNELS.LEARNINGS_SEARCH, filter),
    get: async (id: string): Promise<Learning | null> =>
      typedInvoke<Learning | null>(IPC_CHANNELS.LEARNINGS_GET, id),
    create: async (input: CreateLearningInput): Promise<Learning> =>
      typedInvoke<Learning>(IPC_CHANNELS.LEARNINGS_CREATE, input),
    update: async (id: string, fields: UpdateLearningInput): Promise<Learning | null> =>
      typedInvoke<Learning | null>(IPC_CHANNELS.LEARNINGS_UPDATE, id, fields),
    delete: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.LEARNINGS_DELETE, id),
    distill: async (req: DistillRequest): Promise<DistillResult> =>
      typedInvoke<DistillResult>(IPC_CHANNELS.LEARNINGS_DISTILL, req),
    export: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.LEARNINGS_EXPORT, id),
    similar: async (text: string, limit?: number): Promise<Learning[]> =>
      typedInvoke<Learning[]>(IPC_CHANNELS.LEARNINGS_SIMILAR, text, limit),
    tags: async (): Promise<TagCount[]> => typedInvoke<TagCount[]>(IPC_CHANNELS.LEARNINGS_TAGS),
    status: async (): Promise<LearningsStatus> =>
      typedInvoke<LearningsStatus>(IPC_CHANNELS.LEARNINGS_STATUS),
    warmModel: async (): Promise<void> => typedInvoke<void>(IPC_CHANNELS.LEARNINGS_WARM_MODEL),
    modelCacheSize: async (): Promise<number> =>
      typedInvoke<number>(IPC_CHANNELS.LEARNINGS_MODEL_CACHE_SIZE),
    clearModelCache: async (): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.LEARNINGS_CLEAR_MODEL_CACHE)
  }
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
