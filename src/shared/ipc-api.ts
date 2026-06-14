import type { Workspace, NotificationEvent, ActivityState } from './types';
import type { ShellProfile, WslDistroState, PathContext } from './shell-profiles';
import type { TranscriptMessage } from './sessions';
import type {
  UpdateTaskFields,
  TaskStatus,
  ScheduleInput,
  ArtifactListFilter,
  CreateTaskInput,
  SwarmInput,
  CreateFeatureInput,
  UpdateFeatureInput,
  FeatureStatus,
  ConflictState,
  VerifyCommand
} from './kanban-types';
import type { RuneAssistMode, RuneAssistSelection } from './rune-assist';

export type PtyCreateRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  workspaceId?: string;
  /** If true, PTY exits when cmd finishes instead of falling back to shell. */
  exitOnComplete?: boolean;
  /** Resolved on the main side to a ShellProfile via ShellProfileRegistry. Optional for legacy callers. */
  shellProfileId?: string;
};

export type HostPlatform = 'darwin' | 'linux' | 'win32';

export type HostContextPayload = {
  homeDir: string;
  platform: HostPlatform;
};

export type PtyCreateResponse = {
  paneId: string;
  pid: number;
};

export type PiOpenPayload = {
  cwd: string;
};

export type PiPlanAction = 'approve' | 'reject' | 'continue';

export type PiPlanOpenPayload = {
  path: string;
  paneId?: string;
  requestId?: string;
};

export type PiPlanResponseRequest = {
  paneId: string;
  requestId: string;
  action: PiPlanAction;
  feedback?: string;
};

export type PiLaunchConfig = {
  cmd: string;
};

export type PtyDataPayload = {
  paneId: string;
  data: string;
  paused: boolean;
};

export type PtyInputPayload = {
  paneId: string;
  data: string;
};

export type PtyResizePayload = {
  paneId: string;
  cols: number;
  rows: number;
};

export type PtyExitPayload = {
  paneId: string;
  exitCode: number;
};

export type LayoutSaveRequest = {
  workspace: Workspace;
};

export type LayoutListResponse = {
  workspaces: Workspace[];
};

export type NotificationPayload = NotificationEvent;

export type ActivityStatePayload = {
  paneId: string;
  state: ActivityState;
  lastOutputAt: number;
  timestamp: number;
};

export type PaneFocusedPayload = {
  paneId: string;
};

export type RemoteStatePayload = {
  paneId: string;
  /** True when the pane's foreground process is a remote-shell client (ssh, mosh, etc.). */
  remote: boolean;
};

export type PtyCwdPayload = {
  paneId: string;
  cwd: string;
};

export type GitFileStatus = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  insertions: number;
  deletions: number;
};

export type GitStatusPayload = {
  isRepo: boolean;
  branch: string;
  files: GitFileStatus[];
  diff: string;
  error?: string;
};

export type GitIsRepoPayload = {
  isRepo: boolean;
};

export type GitRepoRootPayload = {
  /** Absolute path to the git toplevel, or null if cwd is not in a repo. */
  root: string | null;
};

export type FileOpenInTabPayload = {
  files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown' | 'pdf'; label: string }>;
};

export type SystemDepResult = {
  name: string;
  found: boolean;
  version?: string;
  installHint: string;
};

export type DirEntry = {
  name: string;
  path: string; // absolute path
  isDirectory: boolean;
};

export type ReaddirResponse =
  | { success: true; entries: DirEntry[] }
  | { success: false; error: string; entries: [] };

export type FileSearchRequest = {
  requestId: number;
  query: string;
  scope?: string;
  limit?: number;
  /** Pane coordinate system; WSL panes run locate/find inside the distro. */
  pathContext?: PathContext;
};

export type FileSearchResult = {
  path: string;
  name: string;
  parentDir: string;
  modifiedAt: number;
  size: number;
};

export type FileSearchResponse =
  | { success: true; requestId: number; results: FileSearchResult[] }
  | { success: false; requestId: number; error: string };

export type FileGrepRequest = {
  requestId: number;
  query: string;
  cwd: string;
  limit?: number;
  /** Pane coordinate system; WSL panes run rg/grep inside the distro. */
  pathContext?: PathContext;
};

export type FileGrepResult = {
  file: string;
  relativePath: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
};

export type FileGrepResponse =
  | { success: true; requestId: number; results: FileGrepResult[] }
  | { success: false; requestId: number; error: string };

export type RecentImageResult = {
  path: string;
  name: string;
  parentDir: string;
  modifiedAt: number;
  size: number;
  thumbnailDataUrl: string;
};

export type RecentImagesResponse =
  | { success: true; results: RecentImageResult[] }
  | { success: false; error: string };

export type ClipboardEntry = {
  id: number;
  text: string;
  timestamp: number;
  charCount: number;
  lineCount: number;
  preview: string; // first 200 chars, truncated
};

export type ClipboardHistoryResponse = {
  entries: ClipboardEntry[];
};

export interface LogEntry {
  tag: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export type WorktreeCreateRequest = {
  repoPath: string;
  /** Pane context; for a WSL pane the worktree is created inside the distro. */
  pathContext?: PathContext;
};

export type WorktreeCreateResponse = {
  worktreePath: string;
  branchName: string;
};

export type WorktreeRemoveRequest = {
  worktreePath: string;
  /** Pane context the worktree belongs to; routes git into the distro for WSL. */
  pathContext?: PathContext;
};

export type ShellProfilesListResponse = {
  profiles: ShellProfile[];
  defaultProfileId: string;
};

export type WslStatusRequest = {
  distro: string;
};

export type WslStatusResponse = {
  state: WslDistroState;
};

export type WslPathRequest = {
  distro: string;
  path: string;
};

export type WslPathResponse = {
  translated: string;
};

export type WslHomeDirRequest = {
  distro: string;
};

export type WslHomeDirResponse = {
  homeDir: string;
};

export type KanbanUpdateTaskRequest = {
  id: string;
  fields: UpdateTaskFields;
};

export type KanbanSetStatusRequest = {
  id: string;
  status: TaskStatus;
};

export type KanbanAddCommentRequest = {
  taskId: string;
  body: string;
};

export type KanbanReplyAndResumeRequest = {
  taskId: string;
  body: string;
};

/** Outcome of a review integration action (merge / PR / accept). */
export type KanbanReviewActionResult = {
  ok: boolean;
  /** PR URL when a pull request was created. */
  prUrl?: string;
  /** True when a merge failed due to conflicts (vs a setup/remote error). */
  conflict?: boolean;
  /** Human-readable failure reason when ok is false. */
  error?: string;
  /** Human-readable success note when ok is true. */
  message?: string;
};

export type KanbanAddAttachmentRequest = {
  taskId: string;
  sourcePath: string;
};

export type KanbanLinkRequest = {
  parentId: string;
  childId: string;
};

export type KanbanRenameBoardRequest = {
  slug: string;
  name: string;
};

export type KanbanSetScheduleRequest = {
  taskId: string;
  input: ScheduleInput;
};

export type KanbanPreviewScheduleResponse =
  | { ok: true; next: number[] }
  | { ok: false; error: string };

export type KanbanListArtifactsRequest = ArtifactListFilter;

export type KanbanReadArtifactPreviewRequest = {
  id: string;
  maxBytes?: number;
};

export type KanbanArtifactPreviewResponse =
  | {
      previewable: true;
      text: string;
      truncated: boolean;
      contentType: string | null;
      size: number;
    }
  | { previewable: false; reason: string };

export type KanbanReuseArtifactRequest = {
  id: string;
  targetTaskId: string;
};

export type KanbanCreateTaskFromArtifactRequest = {
  artifactId: string;
  input: CreateTaskInput;
};

export type KanbanCreateSwarmFromArtifactRequest = {
  artifactId: string;
  input: SwarmInput;
};

export type KanbanListFeaturesRequest = {
  boardId?: string;
  status?: FeatureStatus;
};

export type KanbanCreateFeatureRequest = CreateFeatureInput;

export type KanbanUpdateFeatureRequest = {
  id: string;
  fields: UpdateFeatureInput;
};

/** Result of a local pre-merge conflict check for a task. */
export type KanbanConflictResult = {
  state: ConflictState | null;
  files: string[];
};

/** Result of pruning a single task's worktree; `branchKept` flags an unmerged branch left behind. */
export type KanbanPruneWorktreeResult = {
  ok: boolean;
  branchKept?: boolean;
  error?: string;
};

export type KanbanAssignTaskToFeatureRequest = {
  taskId: string;
  featureId: string | null;
};

export type KanbanAddProjectRequest = {
  boardId: string;
  name: string;
  path: string;
  description?: string | null;
  verifyCommands?: VerifyCommand[];
};

export type PmChatSendRequest = {
  boardId: string;
  text: string;
};

/** Full PM chat state for one board, returned by kanban:pm-state. */
export type PmChatState = {
  boardId: string;
  inFlight: boolean;
  error: string | null;
  messages: TranscriptMessage[];
};

export type PmChatStatusPayload = {
  boardId: string;
  status: 'thinking' | 'idle' | 'error';
  error?: string;
};

export type PmChatTranscriptPayload = {
  boardId: string;
  messages: TranscriptMessage[];
};

// --- Rune Quick-Assist ---
export type RuneAssistSendRequest = {
  cwd: string;
  paneId: string;
  text: string;
  mode: RuneAssistMode;
  contextFile?: string;
  selection?: RuneAssistSelection;
};

export type RuneAssistStopRequest = { cwd: string; paneId: string };
export type RuneAssistResetRequest = { cwd: string };
/** Query in-flight state either by resolved cwd or by the open file (which resolves to its repo root). */
export type RuneAssistStateRequest = { cwd?: string; filePath?: string };

export type RuneAssistState = {
  cwd: string;
  inFlight: boolean;
  error: string | null;
  sessionId: string | null;
  /** The turn currently running for this cwd (for rehydrating the overlay after a refresh). */
  activeTurn: {
    paneId: string;
    mode: RuneAssistMode;
    startedAt: number;
    step: string | null;
  } | null;
};

export type RuneAssistStatusPayload = {
  cwd: string;
  paneId: string;
  phase: 'idle' | 'working' | 'error';
  step?: string;
  error?: string;
};

export type RuneAssistResultPayload = {
  cwd: string;
  paneId: string;
  mode: RuneAssistMode;
  /** Ask: the assistant's answer text. */
  answer?: string;
  /** Edit: files rune wrote (best-effort), for reloading other open panes. */
  changedFiles?: string[];
};

export type {
  EnvSyncConfig,
  EnvSyncTarget,
  TargetStatus,
  EnvDiff,
  SyncOutcome,
  ConflictChoice,
  BucketCreateResult,
  RedactedEnvSyncSecrets,
  RedactedEnvSyncAuth,
  EnvSyncAuthMode,
  EnvSyncAuthInput,
  DiscoveredRepo
} from './env-sync-types';
import type { EnvSyncAuthInput } from './env-sync-types';

/** Passphrase set request: either global (no id) or per-repo (id set). */
export type EnvSyncSetPassphraseRequest = { id?: string; passphrase: string };
export type EnvSyncClearPassphraseRequest = { id?: string };

/** AWS auth set request: either global (no id) or per-repo (id set). */
export type EnvSyncSetAuthRequest = { id?: string; auth: EnvSyncAuthInput };
export type EnvSyncClearAuthRequest = { id?: string };
