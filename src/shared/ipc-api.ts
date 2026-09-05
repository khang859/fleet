import type { Workspace, NotificationEvent, ActivityState } from './types';
import type { ShellProfile, WslDistroState, PathContext } from './shell-profiles';

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

/**
 * Whether the workspace actually reached disk.
 *
 * The save handler used to log its failures and answer `undefined`, which is
 * fine for the debounced autosave - it runs again in a moment - and wrong for
 * workspace creation, which has to tell the user whether the thing they just
 * named exists.
 */
export type LayoutSaveResult = { ok: true } | { ok: false; error: string };

/** Result of creating a Claude config folder that a workspace is about to use. */
export type EnsureConfigDirResult = { ok: true } | { ok: false; error: string };

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

/**
 * A pane telling main what it is doing.
 *
 * Terminals are watched by main, which sees their process. A pane that runs no
 * process - an agent pane - is the only one who knows, so it says so. `gone`
 * is the pane closing: no `pane-closed` is emitted for a pane without a PTY,
 * and a record left behind is a dock badge that never clears.
 */
export type ActivityReportPayload = {
  paneId: string;
  state: ActivityState | 'gone';
  /** What to call this pane in a desktop notification, where it has no glyph. */
  label?: string;
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

/**
 * The working directory of the shell on the far side of an ssh pane. Session
 * state only - it is never written back into the saved layout, which describes
 * where the *local* pane reopens.
 */
export type RemoteCwdPayload = {
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

/** Where a picture landed once copied somewhere a background can safely point. */
export type BackgroundAdoptResponse =
  | { success: true; path: string }
  | { success: false; error: string };

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

/** Environment snapshot included in a "Report a Problem" bundle. */
export interface DiagnosticsInfo {
  version: string;
  platform: string;
  arch: string;
  osRelease: string;
  electron: string;
  chrome: string;
  node: string;
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
