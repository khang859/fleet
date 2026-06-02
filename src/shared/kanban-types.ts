export type TaskStatus =
  | 'triage'
  | 'scheduled'
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'review'
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
  | 'reclaimed'
  | 'incomplete'; // exited cleanly without calling a completion tool (review-required)

export type FeatureStatus = 'active' | 'shipped' | 'archived';
export type FeatureMergeState = 'pending' | 'in_progress' | 'conflict' | 'merged';
export type PrState = 'open' | 'merged' | 'closed' | 'draft';
/** Rolled-up CI status of a PR's checks. */
export type ChecksState = 'passing' | 'failing' | 'pending';
/** Result of a local pre-merge conflict check (Phase 3). */
export type ConflictState = 'clean' | 'conflicts' | 'error';

/** GitHub PR status for a task, polled from `gh`. Null fields until first sync. */
export interface TaskPrInfo {
  url: string | null;
  number: number | null;
  state: PrState | null;
  checksState: ChecksState | null;
  /** gh mergeStateStatus (CLEAN/BEHIND/DIRTY/…), informational only. */
  mergeState: string | null;
  /** Epoch ms of the last successful poll (throttles the poller). */
  syncedAt: number | null;
}

/** A lightweight grouping of tasks that ship together as one feature. */
export interface Feature {
  id: string;
  boardId: string;
  name: string;
  status: FeatureStatus;
  /** Inherited by member tasks so they don't need re-entering folder config. */
  repoPath: string | null;
  /** Merge target inherited by member tasks. */
  baseBranch: string | null;
  /** Per-feature integration branch (Phase 3); null until created. */
  integrationBranch: string | null;
  /** Feature-level merge coordination state (Phase 3). */
  mergeState: FeatureMergeState | null;
  /** The single feature→main PR (Phase 3). */
  prUrl: string | null;
  prNumber: number | null;
  prState: PrState | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFeatureInput {
  boardId: string;
  name: string;
  repoPath?: string | null;
  baseBranch?: string | null;
}

export interface UpdateFeatureInput {
  name?: string;
  status?: FeatureStatus;
  repoPath?: string | null;
  baseBranch?: string | null;
  integrationBranch?: string | null;
  mergeState?: FeatureMergeState | null;
}

/** Aggregate counts for a feature, used by the focus banner and Features dashboard. */
export interface FeatureRollup {
  featureId: string;
  total: number;
  todo: number;
  running: number;
  review: number;
  done: number;
  archived: number;
}

export interface FeatureDetail {
  feature: Feature;
  tasks: Task[];
  rollup: FeatureRollup;
}

/**
 * A live worktree on disk, linked to its task (Phase 4 worktree manager). Ahead/behind
 * are commit counts of the branch vs its base; `merged` means the branch is an ancestor
 * of the base (safe to prune).
 */
export interface WorktreeInfo {
  taskId: string;
  title: string;
  status: TaskStatus;
  repoPath: string;
  workspacePath: string;
  branchName: string | null;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  merged: boolean;
}

/** Outcome of a (bulk) worktree prune: which branches were removed vs kept (unmerged). */
export interface PruneResult {
  pruned: number;
  keptUnmerged: number;
}

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
  /** Repo HEAD captured when a worktree was created: the merge target and child-branch base. */
  baseBranch: string | null;
  modelOverride: string | null;
  skills: string[];
  boardId: string;
  /** Membership in a feature (grouping), distinct from task_links (execution order). */
  featureId: string | null;
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
  /** GitHub PR tracking; null when the task has no PR. */
  prInfo: TaskPrInfo | null;
  /** Local pre-merge conflict check vs the branch's base (Phase 3); null until checked. */
  conflictState: ConflictState | null;
  /** Paths reported as conflicting by the last check; empty unless conflictState==='conflicts'. */
  conflictFiles: string[];
  /** True once the worktree has been pruned from disk (Phase 4); the dir no longer exists. */
  worktreePruned: boolean;
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
  /** Start-point/merge-target a worktree child inherits from its parent. */
  baseBranch?: string | null;
  modelOverride?: string | null;
  skills?: string[];
  boardId?: string;
  featureId?: string | null;
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
  workspacePath?: string | null;
  /** Start-point/merge-target worktree workers inherit (a worktree orchestrator's base). */
  baseBranch?: string | null;
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
