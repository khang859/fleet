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

export type SectorPayload = {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
  description: string | null;
  base_branch: string;
  merge_strategy: string;
  verify_command: string | null;
  lint_command: string | null;
  review_mode: string;
  worktree_enabled: number;
};

export type AddSectorRequest = {
  path: string;
  name?: string;
  description?: string;
  baseBranch?: string;
  mergeStrategy?: string;
};

export type UpdateSectorRequest = {
  sectorId: string;
  fields: Record<string, unknown>;
};

export type SetConfigRequest = {
  key: string;
  value: unknown;
};

export type DeployRequest = {
  sectorId: string;
  prompt: string;
  missionId?: number;
};

export type DeployResponse = {
  crewId: string;
  tabId: string;
  missionId: number;
};

export type RecallRequest = {
  crewId: string;
};

export type MissionListFilter = {
  sectorId?: string;
  status?: string;
};

export type AddMissionRequest = {
  sectorId: string;
  summary: string;
  prompt: string;
  priority?: number;
};

export type AdmiralStateDetailPayload = {
  state: 'standby' | 'thinking' | 'speaking' | 'alert'
  statusText: string
}
