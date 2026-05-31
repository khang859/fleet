export type TaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived';

export type WorkspaceKind = 'scratch' | 'dir' | 'worktree';

/** What a run is doing. 'work' = normal worker; orchestrator runs are 'decompose' | 'specify'. */
export type RunMode = 'work' | 'decompose' | 'specify';

/** A triage task can be flagged for an orchestrator run. */
export type PendingMode = 'decompose' | 'specify';

export type RunOutcome =
  | 'completed'
  | 'blocked'
  | 'crashed'
  | 'timed_out'
  | 'spawn_failed'
  | 'gave_up'
  | 'reclaimed';

export interface Task {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  tenant: string | null;
  workspaceKind: WorkspaceKind;
  workspacePath: string | null;
  repoPath: string | null;
  branchName: string | null;
  modelOverride: string | null;
  skills: string[];
  idempotencyKey: string | null;
  result: string | null;
  pendingMode: PendingMode | null;
  claimLock: string | null;
  claimExpires: number | null;
  workerPid: number | null;
  currentRunId: number | null;
  lastHeartbeatAt: number | null;
  consecutiveFailures: number;
  lastFailureError: string | null;
  maxRuntimeSeconds: number | null;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRun {
  id: number;
  taskId: string;
  profile: string | null;
  status: 'running' | 'finished';
  mode: RunMode;
  workerPid: number | null;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  runId: number | null;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface TaskComment {
  id: number;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  storedPath: string;
  contentType: string | null;
  size: number;
  createdAt: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assignee?: string | null;
  status?: TaskStatus;
  priority?: number;
  tenant?: string | null;
  workspaceKind?: WorkspaceKind;
  repoPath?: string;
  branchName?: string | null;
  modelOverride?: string | null;
  skills?: string[];
  idempotencyKey?: string | null;
  maxRuntimeSeconds?: number | null;
  maxRetries?: number;
}

export interface UpdateTaskFields {
  title?: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  tenant?: string | null;
}

export interface BoardCard extends Task {
  commentCount: number;
  childTotal: number;
  childDone: number;
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  runs: TaskRun[];
  events: TaskEvent[];
  parents: Task[];
  children: Task[];
  attachments: TaskAttachment[];
}
