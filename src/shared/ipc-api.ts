import type { Workspace, NotificationEvent, ActivityState } from './types';

export type PtyCreateRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  workspaceId?: string;
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

export type FileOpenInTabPayload = {
  files: Array<{ path: string; paneType: 'file' | 'image'; label: string }>;
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
};

export type WorktreeCreateResponse = {
  worktreePath: string;
  branchName: string;
};

export type WorktreeRemoveRequest = {
  worktreePath: string;
};
