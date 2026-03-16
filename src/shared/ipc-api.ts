import type { Workspace, NotificationEvent, AgentVisualState } from './types';

export type PtyCreateRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
};

export type PtyCreateResponse = {
  paneId: string;
  pid: number;
};

export type PtyDataPayload = {
  paneId: string;
  data: string;
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

export type PaneFocusedPayload = {
  paneId: string;
};

export type PtyCwdPayload = {
  paneId: string;
  cwd: string;
};

export type AgentStatePayload = {
  states: AgentVisualState[];
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
