export type TaskStatus =
  | 'triage'
  | 'scheduled'
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

/** A schedule the user attaches to a task. Discriminated by `kind`. */
export type ScheduleInput =
  | { kind: 'once'; at: number } // epoch ms
  | { kind: 'interval'; everyMs: number } // > 0
  | { kind: 'cron'; expr: string }; // a valid cron expression

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
  boardId: string;
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
  scheduleKind: 'once' | 'interval' | 'cron' | null;
  scheduleCron: string | null;
  scheduleIntervalMs: number | null;
  nextRunAt: number | null;
  schedulePaused: boolean;
  scheduledFrom: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Board {
  slug: string;
  name: string;
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

export type ArtifactKind = 'document' | 'code' | 'data' | 'other';
export type ArtifactState = 'kept' | 'discarded';

export interface TaskArtifact {
  id: string;
  taskId: string;
  runId: number | null;
  boardId: string;
  title: string | null;
  filename: string;
  /** Normalized, workspace-relative path originally registered by the agent. */
  sourceRelPath: string;
  storedPath: string;
  kind: ArtifactKind;
  contentType: string | null;
  size: number;
  state: ArtifactState;
  createdAt: number;
  discardedAt: number | null;
}

/** A row in the cross-board Artifacts browser: a TaskArtifact joined with its task/board. */
export interface ArtifactListItem extends TaskArtifact {
  taskTitle: string;
  boardName: string;
}

/** Filters for the global Artifacts browser. */
export interface ArtifactListFilter {
  boardSlug?: string;
  state?: ArtifactState;
  kind?: ArtifactKind;
  query?: string;
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
  workspacePath?: string;
  branchName?: string | null;
  modelOverride?: string | null;
  skills?: string[];
  boardId?: string;
  idempotencyKey?: string | null;
  maxRuntimeSeconds?: number | null;
  maxRetries?: number;
  scheduledFrom?: string | null;
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
  /** Count of kept (non-discarded) artifacts produced by this task. */
  artifactCount: number;
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  runs: TaskRun[];
  events: TaskEvent[];
  parents: Task[];
  children: Task[];
  attachments: TaskAttachment[];
  artifacts: TaskArtifact[];
}

/** One parallel worker card in a swarm. */
export interface SwarmWorkerSpec {
  profile: string;
  title: string;
  body?: string;
  skills?: string[];
  priority?: number;
}

/** Input to create a swarm graph. Workspace/runtime fields are resolved by the command layer. */
export interface SwarmInput {
  goal: string;
  workers: SwarmWorkerSpec[];
  verifierAssignee: string;
  synthesizerAssignee: string;
  boardId?: string;
  tenant?: string | null;
  priority?: number;
  workspaceKind?: WorkspaceKind;
  repoPath?: string;
  maxRuntimeSeconds?: number | null;
  rootTitle?: string;
  verifierTitle?: string;
  synthesizerTitle?: string;
  createdBy?: string;
  /** When set, a copy of this kept artifact is attached to the root swarm task. */
  seedArtifactId?: string;
}

/** IDs produced by createSwarm. */
export interface SwarmCreated {
  rootId: string;
  workerIds: string[];
  verifierId: string;
  synthesizerId: string;
}
