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
  RemoteStatePayload,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
  WorktreeRemoveRequest,
  PiOpenPayload,
  PiPlanOpenPayload,
  PiPlanResponseRequest,
  PiLaunchConfig,
  ShellProfilesListResponse,
  WslStatusResponse,
  WslPathResponse,
  WslHomeDirResponse,
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanReplyAndResumeRequest,
  KanbanLinkRequest,
  KanbanAddAttachmentRequest,
  KanbanRenameBoardRequest,
  KanbanSetScheduleRequest,
  KanbanPreviewScheduleResponse,
  KanbanListArtifactsRequest,
  KanbanReadArtifactPreviewRequest,
  KanbanArtifactPreviewResponse,
  KanbanReuseArtifactRequest,
  KanbanCreateTaskFromArtifactRequest,
  KanbanCreateSwarmFromArtifactRequest,
  KanbanReviewActionResult,
  KanbanListFeaturesRequest,
  KanbanCreateFeatureRequest,
  KanbanUpdateFeatureRequest,
  KanbanAssignTaskToFeatureRequest,
  KanbanConflictResult,
  KanbanPruneWorktreeResult,
  PmChatSendRequest,
  PmChatState,
  PmChatStatusPayload,
  PmChatTranscriptPayload,
  KanbanAddProjectRequest,
  RuneAssistSendRequest,
  RuneAssistStopRequest,
  RuneAssistResetRequest,
  RuneAssistStateRequest,
  RuneAssistState,
  RuneAssistStatusPayload,
  RuneAssistResultPayload
} from '../shared/ipc-api';
import type {
  Board,
  BoardCard,
  TaskDetail,
  CreateTaskInput,
  Task,
  TaskEvent,
  TaskAttachment,
  ArtifactListItem,
  ScheduleInput,
  SwarmInput,
  SwarmCreated,
  Feature,
  FeatureDetail,
  FeatureSuggestion,
  PmProposal,
  BoardDigestConfig,
  WorktreeInfo,
  PruneResult,
  Project,
  VerifyCommand
} from '../shared/kanban-types';
import type { WslDistroState, PathContext } from '../shared/shell-profiles';
import type { RuneStatus, RuneInstallResult } from '../shared/rune';
import type { RuneSettings, RuneSecrets } from '../shared/rune-config-types';
import type {
  Workspace,
  FleetSettings,
  FleetSettingsPatch,
  UpdateStatus,
  ImageGenerationMeta,
  ImageSettings,
  AnnotationMeta
} from '../shared/types';
import type {
  PiSettings,
  PiProvider,
  PiModelsFile,
  BuiltInProviderStatus,
  ModelEntry
} from '../shared/pi-config-types';
import type {
  RedactedBedrock,
  BedrockWritePatch,
  BedrockSecretField
} from '../shared/pi-env-injection-types';
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
import type { SessionAgent, SessionSummary, SessionTranscript } from '../shared/sessions';
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatSettings,
  ChatSendRequest,
  ChatRegenerateRequest,
  ChatEditRequest,
  ChatSendResponse,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload,
  ChatToolStatusPayload,
  ChatConversationRenamedPayload,
  ChatAuditEntry
} from '../shared/chat-types';
import type { PermissionRequestPayload, PermissionOutcome } from '../shared/chat-permissions';
import type { McpServersConfig, McpServerStatus } from '../shared/mcp-types';
import type { SkillState, SkillsView } from '../shared/skill-types';
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
      onChannel(IPC_CHANNELS.ACTIVITY_STATE, callback)
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
    listActions: async (
      provider?: string
    ): Promise<
      Array<{
        id: string;
        actionType: string;
        provider: string;
        name: string;
        description: string;
        model: string;
      }>
    > => typedInvoke(IPC_CHANNELS.IMAGES_LIST_ACTIONS, provider)
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
  rune: {
    getVersion: async (): Promise<RuneStatus> => typedInvoke(IPC_CHANNELS.RUNE_VERSION),
    install: async (): Promise<RuneInstallResult> => typedInvoke(IPC_CHANNELS.RUNE_INSTALL),
    readSettings: async (): Promise<RuneSettings> =>
      typedInvoke(IPC_CHANNELS.RUNE_CONFIG_READ_SETTINGS),
    writeSettings: async (patch: Partial<RuneSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.RUNE_CONFIG_WRITE_SETTINGS, patch),
    readSecrets: async (): Promise<RuneSecrets> =>
      typedInvoke(IPC_CHANNELS.RUNE_CONFIG_READ_SECRETS),
    writeSecrets: async (patch: Record<string, string>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.RUNE_CONFIG_WRITE_SECRETS, patch),
    openConfigFolder: async (): Promise<void> => typedInvoke(IPC_CHANNELS.RUNE_CONFIG_OPEN_FOLDER)
  },
  pi: {
    onOpen: (callback: (payload: PiOpenPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PI_OPEN, callback),
    onPlanOpen: (callback: (payload: PiPlanOpenPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.PI_PLAN_OPEN, callback),
    respondToPlan: async (req: PiPlanResponseRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_PLAN_RESPOND, req),
    getLaunchConfig: async (paneId: string): Promise<PiLaunchConfig> =>
      typedInvoke(IPC_CHANNELS.PI_LAUNCH_CONFIG, { paneId }),
    getVersion: async (): Promise<{ version: string | null; installed: boolean }> =>
      typedInvoke(IPC_CHANNELS.PI_VERSION),
    checkForUpdates: async (): Promise<{
      previousVersion: string | null;
      currentVersion: string | null;
      updated: boolean;
      installed: boolean;
    }> => typedInvoke(IPC_CHANNELS.PI_CHECK_UPDATES)
  },
  piConfig: {
    readSettings: async (): Promise<PiSettings> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_READ_SETTINGS),
    writeSettings: async (patch: Partial<PiSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_WRITE_SETTINGS, patch),
    readModels: async (): Promise<PiModelsFile> => typedInvoke(IPC_CHANNELS.PI_CONFIG_READ_MODELS),
    writeProvider: async (id: string, provider: PiProvider): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_WRITE_PROVIDER, { id, provider }),
    deleteProvider: async (id: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_DELETE_PROVIDER, id),
    renameProvider: async (oldId: string, newId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_RENAME_PROVIDER, { oldId, newId }),
    getBuiltInStatus: async (): Promise<BuiltInProviderStatus[]> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_BUILT_IN_STATUS),
    listAvailableModels: async (): Promise<ModelEntry[]> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_LIST_MODELS),
    openConfigFolder: async (): Promise<void> => typedInvoke(IPC_CHANNELS.PI_CONFIG_OPEN_FOLDER)
  },
  piEnv: {
    readBedrock: async (): Promise<RedactedBedrock | undefined> =>
      (await typedInvoke<{ bedrock?: RedactedBedrock }>(IPC_CHANNELS.PI_ENV_READ_BEDROCK)).bedrock,
    writeBedrock: async (patch: BedrockWritePatch): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_ENV_WRITE_BEDROCK, patch),
    clearSecret: async (field: BedrockSecretField): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_ENV_CLEAR_SECRET, field),
    isEncryptionAvailable: async (): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.PI_ENV_IS_ENCRYPTION_AVAILABLE)
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
  kanban: {
    listBoard: async (boardSlug?: string): Promise<BoardCard[]> =>
      typedInvoke<BoardCard[]>(IPC_CHANNELS.KANBAN_LIST_BOARD, boardSlug),
    getTask: async (taskId: string): Promise<TaskDetail | null> =>
      typedInvoke<TaskDetail | null>(IPC_CHANNELS.KANBAN_GET_TASK, taskId),
    createTask: async (input: CreateTaskInput): Promise<Task> =>
      typedInvoke<Task>(IPC_CHANNELS.KANBAN_CREATE_TASK, input),
    createSwarm: async (input: SwarmInput): Promise<SwarmCreated> =>
      typedInvoke<SwarmCreated>(IPC_CHANNELS.KANBAN_CREATE_SWARM, input),
    updateTask: async (req: KanbanUpdateTaskRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_UPDATE_TASK, req),
    setStatus: async (req: KanbanSetStatusRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_STATUS, req),
    addComment: async (req: KanbanAddCommentRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_ADD_COMMENT, req),
    replyAndResume: async (req: KanbanReplyAndResumeRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REPLY_AND_RESUME, req),
    addLink: async (req: KanbanLinkRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_ADD_LINK, req),
    removeLink: async (req: KanbanLinkRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REMOVE_LINK, req),
    nudge: async (): Promise<void> => typedInvoke<void>(IPC_CHANNELS.KANBAN_NUDGE),
    mergeTask: async (taskId: string): Promise<KanbanReviewActionResult> =>
      typedInvoke<KanbanReviewActionResult>(IPC_CHANNELS.KANBAN_MERGE_TASK, taskId),
    createPr: async (taskId: string): Promise<KanbanReviewActionResult> =>
      typedInvoke<KanbanReviewActionResult>(IPC_CHANNELS.KANBAN_CREATE_PR, taskId),
    acceptTask: async (taskId: string): Promise<KanbanReviewActionResult> =>
      typedInvoke<KanbanReviewActionResult>(IPC_CHANNELS.KANBAN_ACCEPT_TASK, taskId),
    decompose: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DECOMPOSE, taskId),
    specify: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SPECIFY, taskId),
    pickAttachment: async (): Promise<string[]> =>
      typedInvoke<string[]>(IPC_CHANNELS.KANBAN_PICK_ATTACHMENT),
    addAttachment: async (req: KanbanAddAttachmentRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_ADD_ATTACHMENT, req),
    removeAttachment: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REMOVE_ATTACHMENT, id),
    saveAttachmentCopy: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SAVE_ATTACHMENT_COPY, id),
    listArtifacts: async (filter?: KanbanListArtifactsRequest): Promise<ArtifactListItem[]> =>
      typedInvoke<ArtifactListItem[]>(IPC_CHANNELS.KANBAN_LIST_ARTIFACTS, filter ?? {}),
    discardArtifact: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DISCARD_ARTIFACT, id),
    restoreArtifact: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_RESTORE_ARTIFACT, id),
    removeArtifact: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REMOVE_ARTIFACT, id),
    saveArtifactCopy: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SAVE_ARTIFACT_COPY, id),
    revealArtifact: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REVEAL_ARTIFACT, id),
    readArtifactPreview: async (
      req: KanbanReadArtifactPreviewRequest
    ): Promise<KanbanArtifactPreviewResponse> =>
      typedInvoke<KanbanArtifactPreviewResponse>(IPC_CHANNELS.KANBAN_READ_ARTIFACT_PREVIEW, req),
    reuseArtifact: async (req: KanbanReuseArtifactRequest): Promise<TaskAttachment> =>
      typedInvoke<TaskAttachment>(IPC_CHANNELS.KANBAN_REUSE_ARTIFACT, req),
    createTaskFromArtifact: async (req: KanbanCreateTaskFromArtifactRequest): Promise<Task> =>
      typedInvoke<Task>(IPC_CHANNELS.KANBAN_CREATE_TASK_FROM_ARTIFACT, req),
    createSwarmFromArtifact: async (
      req: KanbanCreateSwarmFromArtifactRequest
    ): Promise<SwarmCreated> =>
      typedInvoke<SwarmCreated>(IPC_CHANNELS.KANBAN_CREATE_SWARM_FROM_ARTIFACT, req),
    revealTaskWorkspace: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REVEAL_TASK_WORKSPACE, taskId),
    discardTaskWorkspaceLeftovers: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DISCARD_TASK_WORKSPACE_LEFTOVERS, taskId),
    listBoards: async (): Promise<Board[]> => typedInvoke<Board[]>(IPC_CHANNELS.KANBAN_LIST_BOARDS),
    createBoard: async (name: string): Promise<Board> =>
      typedInvoke<Board>(IPC_CHANNELS.KANBAN_CREATE_BOARD, name),
    renameBoard: async (req: KanbanRenameBoardRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_RENAME_BOARD, req),
    deleteBoard: async (slug: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DELETE_BOARD, slug),
    onBoardsChanged: (callback: () => void): Unsubscribe =>
      onChannel<void>(IPC_CHANNELS.KANBAN_BOARDS_CHANGED, () => callback()),
    onEvent: (callback: (event: TaskEvent) => void): Unsubscribe =>
      onChannel<TaskEvent>(IPC_CHANNELS.KANBAN_EVENT, callback),
    onKanbanFocusTask: (
      callback: (payload: { boardSlug: string; taskId?: string }) => void
    ): Unsubscribe =>
      onChannel<{ boardSlug: string; taskId?: string }>(IPC_CHANNELS.KANBAN_FOCUS_TASK, callback),
    setSchedule: async (req: KanbanSetScheduleRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_SCHEDULE, req),
    clearSchedule: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_CLEAR_SCHEDULE, taskId),
    pauseSchedule: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_PAUSE_SCHEDULE, taskId),
    resumeSchedule: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_RESUME_SCHEDULE, taskId),
    previewSchedule: async (input: ScheduleInput): Promise<KanbanPreviewScheduleResponse> =>
      typedInvoke<KanbanPreviewScheduleResponse>(IPC_CHANNELS.KANBAN_PREVIEW_SCHEDULE, input),
    listFeatures: async (filter?: KanbanListFeaturesRequest): Promise<Feature[]> =>
      typedInvoke<Feature[]>(IPC_CHANNELS.KANBAN_LIST_FEATURES, filter ?? {}),
    getFeature: async (id: string): Promise<FeatureDetail | null> =>
      typedInvoke<FeatureDetail | null>(IPC_CHANNELS.KANBAN_GET_FEATURE, id),
    createFeature: async (req: KanbanCreateFeatureRequest): Promise<Feature> =>
      typedInvoke<Feature>(IPC_CHANNELS.KANBAN_CREATE_FEATURE, req),
    updateFeature: async (req: KanbanUpdateFeatureRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_UPDATE_FEATURE, req),
    archiveFeature: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_ARCHIVE_FEATURE, id),
    deleteFeature: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DELETE_FEATURE, id),
    assignTaskToFeature: async (req: KanbanAssignTaskToFeatureRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_ASSIGN_TASK_TO_FEATURE, req),
    listSuggestions: async (boardId: string): Promise<FeatureSuggestion[]> =>
      typedInvoke<FeatureSuggestion[]>(IPC_CHANNELS.KANBAN_LIST_SUGGESTIONS, boardId),
    acceptSuggestion: async (id: string): Promise<Feature> =>
      typedInvoke<Feature>(IPC_CHANNELS.KANBAN_ACCEPT_SUGGESTION, id),
    dismissSuggestion: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DISMISS_SUGGESTION, id),
    listProposals: async (boardId: string): Promise<PmProposal[]> =>
      typedInvoke<PmProposal[]>(IPC_CHANNELS.KANBAN_LIST_PROPOSALS, boardId),
    approveProposal: async (id: string): Promise<PmProposal> =>
      typedInvoke<PmProposal>(IPC_CHANNELS.KANBAN_APPROVE_PROPOSAL, id),
    dismissProposal: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DISMISS_PROPOSAL, id),
    getDigestConfig: async (boardId: string): Promise<BoardDigestConfig> =>
      typedInvoke<BoardDigestConfig>(IPC_CHANNELS.KANBAN_GET_DIGEST_CONFIG, boardId),
    setDigestCron: async (boardId: string, cron: string | null): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_DIGEST_CRON, boardId, cron),
    redecompose: async (featureId: string): Promise<Task> =>
      typedInvoke<Task>(IPC_CHANNELS.KANBAN_REDECOMPOSE, featureId),
    shipFeature: async (featureId: string): Promise<KanbanReviewActionResult> =>
      typedInvoke<KanbanReviewActionResult>(IPC_CHANNELS.KANBAN_SHIP_FEATURE, featureId),
    syncFeature: async (featureId: string): Promise<KanbanReviewActionResult> =>
      typedInvoke<KanbanReviewActionResult>(IPC_CHANNELS.KANBAN_SYNC_FEATURE, featureId),
    checkConflicts: async (taskId: string): Promise<KanbanConflictResult> =>
      typedInvoke<KanbanConflictResult>(IPC_CHANNELS.KANBAN_CHECK_CONFLICTS, taskId),
    listWorktrees: async (boardId: string): Promise<WorktreeInfo[]> =>
      typedInvoke<WorktreeInfo[]>(IPC_CHANNELS.KANBAN_LIST_WORKTREES, boardId),
    pruneWorktree: async (taskId: string): Promise<KanbanPruneWorktreeResult> =>
      typedInvoke<KanbanPruneWorktreeResult>(IPC_CHANNELS.KANBAN_PRUNE_WORKTREE, taskId),
    pruneMergedWorktrees: async (boardId: string): Promise<PruneResult> =>
      typedInvoke<PruneResult>(IPC_CHANNELS.KANBAN_PRUNE_MERGED_WORKTREES, boardId),
    pmSend: async (req: PmChatSendRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_PM_SEND, req),
    pmState: async (boardId: string): Promise<PmChatState> =>
      typedInvoke<PmChatState>(IPC_CHANNELS.KANBAN_PM_STATE, boardId),
    pmReset: async (boardId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_PM_RESET, boardId),
    onPmStatus: (callback: (payload: PmChatStatusPayload) => void): Unsubscribe =>
      onChannel<PmChatStatusPayload>(IPC_CHANNELS.KANBAN_PM_STATUS, callback),
    onPmTranscript: (callback: (payload: PmChatTranscriptPayload) => void): Unsubscribe =>
      onChannel<PmChatTranscriptPayload>(IPC_CHANNELS.KANBAN_PM_TRANSCRIPT, callback),
    listProjects: async (boardId: string): Promise<Project[]> =>
      typedInvoke<Project[]>(IPC_CHANNELS.KANBAN_LIST_PROJECTS, boardId),
    addProject: async (req: KanbanAddProjectRequest): Promise<Project> =>
      typedInvoke<Project>(IPC_CHANNELS.KANBAN_ADD_PROJECT, req),
    removeProject: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_REMOVE_PROJECT, id),
    setDefaultProject: async (id: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_DEFAULT_PROJECT, id),
    setProjectVerifyCommands: async (id: string, cmds: VerifyCommand[]): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_PROJECT_VERIFY, id, cmds)
  },
  runeAssist: {
    send: async (req: RuneAssistSendRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_SEND, req),
    stop: async (req: RuneAssistStopRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_STOP, req),
    reset: async (req: RuneAssistResetRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.RUNE_ASSIST_RESET, req),
    getState: async (req: RuneAssistStateRequest): Promise<RuneAssistState> =>
      typedInvoke<RuneAssistState>(IPC_CHANNELS.RUNE_ASSIST_STATE, req),
    onStatus: (callback: (payload: RuneAssistStatusPayload) => void): Unsubscribe =>
      onChannel<RuneAssistStatusPayload>(IPC_CHANNELS.RUNE_ASSIST_STATUS, callback),
    onResult: (callback: (payload: RuneAssistResultPayload) => void): Unsubscribe =>
      onChannel<RuneAssistResultPayload>(IPC_CHANNELS.RUNE_ASSIST_RESULT, callback)
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
  sessions: {
    list: async (): Promise<SessionSummary[]> => typedInvoke(IPC_CHANNELS.SESSIONS_LIST),
    read: async (args: {
      agent: SessionAgent;
      id: string;
      cwd: string;
    }): Promise<SessionTranscript | null> => typedInvoke(IPC_CHANNELS.SESSIONS_READ, args),
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
  },
  chat: {
    listConversations: async (): Promise<ChatConversation[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS),
    createConversation: async (): Promise<ChatConversation> =>
      typedInvoke(IPC_CHANNELS.CHAT_CREATE_CONVERSATION),
    renameConversation: async (id: string, title: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_RENAME_CONVERSATION, { id, title }),
    setConversationModel: async (id: string, model: string | null): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_SET_CONVERSATION_MODEL, { id, model }),
    deleteConversation: async (id: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, id),
    getMessages: async (conversationId: string): Promise<ChatMessage[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_GET_MESSAGES, conversationId),
    send: async (req: ChatSendRequest): Promise<ChatSendResponse> =>
      typedInvoke(IPC_CHANNELS.CHAT_SEND, req),
    regenerate: async (req: ChatRegenerateRequest): Promise<{ streamId: string }> =>
      typedInvoke(IPC_CHANNELS.CHAT_REGENERATE, req),
    editMessage: async (req: ChatEditRequest): Promise<ChatSendResponse> =>
      typedInvoke(IPC_CHANNELS.CHAT_EDIT_MESSAGE, req),
    selectVariant: async (messageId: string): Promise<ChatMessage[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_SELECT_VARIANT, messageId),
    cancel: async (streamId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_CANCEL, streamId),
    listModels: async (): Promise<ChatModel[]> => typedInvoke(IPC_CHANNELS.CHAT_LIST_MODELS),
    listImageModels: async (): Promise<ChatModel[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_LIST_IMAGE_MODELS),
    getSettings: async (): Promise<ChatSettings> => typedInvoke(IPC_CHANNELS.CHAT_GET_SETTINGS),
    patchSettings: async (patch: Partial<ChatSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_PATCH_SETTINGS, patch),
    setKey: async (key: string): Promise<void> => typedInvoke(IPC_CHANNELS.CHAT_SET_KEY, key),
    hasKey: async (): Promise<boolean> => typedInvoke(IPC_CHANNELS.CHAT_HAS_KEY),
    onStreamChunk: (cb: (p: ChatStreamChunkPayload) => void): Unsubscribe =>
      onChannel<ChatStreamChunkPayload>(IPC_CHANNELS.CHAT_STREAM_CHUNK, cb),
    onStreamDone: (cb: (p: ChatStreamDonePayload) => void): Unsubscribe =>
      onChannel<ChatStreamDonePayload>(IPC_CHANNELS.CHAT_STREAM_DONE, cb),
    onStreamError: (cb: (p: ChatStreamErrorPayload) => void): Unsubscribe =>
      onChannel<ChatStreamErrorPayload>(IPC_CHANNELS.CHAT_STREAM_ERROR, cb),
    onToolStatus: (cb: (p: ChatToolStatusPayload) => void): Unsubscribe =>
      onChannel<ChatToolStatusPayload>(IPC_CHANNELS.CHAT_TOOL_STATUS, cb),
    onPermissionRequest: (cb: (p: PermissionRequestPayload) => void): Unsubscribe =>
      onChannel<PermissionRequestPayload>(IPC_CHANNELS.CHAT_PERMISSION_REQUEST, cb),
    decidePermission: async (requestId: string, outcome: PermissionOutcome): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_PERMISSION_DECIDE, { requestId, outcome }),
    onConversationRenamed: (cb: (p: ChatConversationRenamedPayload) => void): Unsubscribe =>
      onChannel<ChatConversationRenamedPayload>(IPC_CHANNELS.CHAT_CONVERSATION_RENAMED, cb),
    mcpGet: async (): Promise<McpServerStatus[]> => typedInvoke(IPC_CHANNELS.CHAT_MCP_GET),
    mcpSet: async (config: McpServersConfig): Promise<McpServerStatus[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_MCP_SET, config),
    skillsGet: async (): Promise<SkillsView> => typedInvoke(IPC_CHANNELS.CHAT_SKILLS_GET),
    skillsSetState: async (name: string, state: SkillState): Promise<SkillsView> =>
      typedInvoke(IPC_CHANNELS.CHAT_SKILLS_SET_STATE, { name, state }),
    skillsRescan: async (): Promise<SkillsView> => typedInvoke(IPC_CHANNELS.CHAT_SKILLS_RESCAN),
    skillsReveal: async (): Promise<void> => typedInvoke(IPC_CHANNELS.CHAT_SKILLS_REVEAL),
    auditList: async (conversationId?: string): Promise<ChatAuditEntry[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_AUDIT_LIST, { conversationId })
  }
};

contextBridge.exposeInMainWorld('fleet', fleetApi);

export type FleetApi = typeof fleetApi;
