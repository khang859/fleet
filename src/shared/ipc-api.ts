import type { Workspace, NotificationEvent, AgentVisualState } from './types';

export type PtyCreateRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
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

export type StarbaseRuntimeStatus = {
  state: 'starting' | 'ready' | 'error';
  error?: string;
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
  missionId: number;
  // TODO(#30): tabId removed — crews are now headless (stream-json, no terminal tab)
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
  dependsOnMissionId?: number;
};

export type AdmiralStateDetailPayload = {
  state: 'standby' | 'thinking' | 'speaking' | 'alert';
  statusText: string;
};

export type AdmiralStatusPayload = {
  status: string;
  paneId: string | null;
  error?: string;
  exitCode?: number;
};

export type CreateTabPayload = {
  tabId: string;
  label: string;
  cwd: string;
  avatarVariant?: string;
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

// ---- Starbase data shapes (used by preload bridge + renderer) ----

export type StarbaseSectorRow = {
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
  model: string | null;
  system_prompt: string | null;
  allowed_tools: string | null;
  mcp_config: string | null;
  created_at: string;
  updated_at: string;
};

export type StarbaseCrewRow = {
  id: string;
  sector_id: string;
  mission_id: number | null;
  sector_path: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  status: string;
  mission_summary: string | null;
  avatar_variant: string | null;
  pid: number | null;
  deadline: string | null;
  created_at: string;
  updated_at: string;
};

export type StarbaseMissionRow = {
  id: number;
  sector_id: string;
  crew_id: string | null;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  status: string;
  priority: number;
  depends_on_mission_id: number | null;
  result: string | null;
  verify_result: string | null;
  review_verdict: string | null;
  review_notes: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type StarbaseCommRow = {
  id: number;
  from_crew: string | null;
  to_crew: string | null;
  thread_id: string | null;
  in_reply_to: number | null;
  type: string;
  payload: string;
  read: number;
  repeat_count: number;
  created_at: string;
};

export type StarbaseMemoRow = {
  id: number;
  crew_id: string | null;
  mission_id: number | null;
  event_type: string;
  file_path: string;
  status: string;
  summary: string;
  created_at: string;
};

export type StarbaseSupplyRoute = {
  id: number;
  upstream_sector_id: string;
  downstream_sector_id: string;
  relationship: string | null;
  created_at: string;
};

export type StarbaseRetentionStats = {
  tables: Record<string, number>;
  dbSizeBytes: number;
  dbPath: string;
};

export type StarbaseCleanupResult = {
  comms: number;
  cargo: number;
  shipsLog: number;
};

export type StarbaseLogEntry = {
  id: number;
  source: 'ships_log' | 'comms';
  timestamp: string;
  eventType: string;
  actor: string | null;
  target?: string | null;
  detail: unknown;
};

export type SentinelAlert = {
  id: number;
  type: string;
  payload: string;
  createdAt: string;
  fromCrew: string | null;
};

export type SentinelStatusPayload = {
  running: boolean;
  lastSweepAt: string | null;
  alerts: SentinelAlert[];
};

export type StarbaseStatusUpdatePayload = {
  crew?: StarbaseCrewRow[];
  missions?: StarbaseMissionRow[];
  sectors?: StarbaseSectorRow[];
  unreadCount?: number;
  firstOfficer?: { status: 'idle' | 'working' | 'memo'; statusText: string; unreadMemos: number };
  navigator?: { status: 'standby' | 'working'; statusText: string };
  sentinel?: SentinelStatusPayload;
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
