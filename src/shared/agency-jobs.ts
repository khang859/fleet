import type { AgencyJob, AgencyJobEvent, JobState } from './agency';

export type { AgencyLeftover, ResourceKind } from './agency';
import type { CrewRuntime } from './agency-crew';
import type { DeliverableKind, Plan, PlanDiffEntry, PlanInput } from './agency-plan';
import type { PrReview } from './pr-review';

/** The states a job takes results and step updates in: crew are at work, or it delivered. */
export const ACCEPTS_RESULTS: readonly JobState[] = ['running', 'waiting', 'delivered'];

/**
 * What one job holds beyond its row: its plan versions, its steps and its
 * record. The snapshot stays light and names jobs only; a pane fetches this
 * for the job it shows, and again when a change names that job.
 */

export type PlanVersionStatus = 'proposed' | 'approved' | 'rejected' | 'replaced' | 'superseded';

/**
 * One thing the pre-approval check found. `block` keeps Approve disabled.
 * `fix: 'use-branch'` means the card can offer local branches in place of PRs;
 * `fix: 'trust-claude'` that it can open Claude Code in `path` to trust it.
 */
export type PlanIssue = {
  code: string;
  severity: 'warn' | 'block';
  text: string;
  step?: string;
  member?: string;
  fix?: 'use-branch' | 'trust-claude';
  path?: string;
};

/** A path this plan's `step` and a step of another running job both expect to touch. */
export type PlanOverlap = { jobId: number; member: string; path: string; step: string };

/**
 * Where a member's work can start, for the card's base choice: its default
 * branch tip or its current HEAD. `pinned` is set once an earlier approval
 * pinned it, and a later change keeps it.
 */
export type MemberBase = {
  member: string;
  defaultBranch: string | null;
  defaultSha: string | null;
  headBranch: string | null;
  headSha: string | null;
  pinned: { sha: string; from: 'default' | 'head' } | null;
};

/** The env files a step's crew get, by path from the project root. */
export type StepEnvFiles = { stepId: string; files: string[] };

export type PlanChecks = {
  issues: PlanIssue[];
  overlap: PlanOverlap[];
  bases: MemberBase[];
  envFiles: StepEnvFiles[];
};

export const NO_PLAN_CHECKS: PlanChecks = { issues: [], overlap: [], bases: [], envFiles: [] };

/** Crew members that may work at once, in one job and across every job. */
export const DEFAULT_CREW_LIMIT = 4;

/** A crew member a plan change stops, by its step. */
export type StoppedCrew = { crewId: number; stepId: string; label: string };

/** A running step whose role, runtime or model a change swaps. */
export type StepSwap = { stepId: string; fields: Array<'role' | 'runtime' | 'model'> };

export type SwapChoice = 'continue' | 'restart';

/**
 * What approving a plan change would do, for the change card: the crew it
 * stops, the running steps it swaps, the open questions it withdraws, what
 * was already delivered and what was spent.
 */
export type PlanEffects = {
  stopCrew: StoppedCrew[];
  swaps: StepSwap[];
  withdrawnQuestions: number[];
  deliveredResults: number;
  spendUsd: number;
};

/** The base commit each member's work starts from, pinned at approval. */
export type PlanBases = Record<string, { sha: string; from: 'default' | 'head' }>;

export type AgencyPlanVersion = {
  /** Global id: what the tool result and the plan action carry. */
  id: number;
  jobId: number;
  /** Per job: v1, v2... */
  version: number;
  status: PlanVersionStatus;
  kind: 'initial' | 'change';
  author: 'admiral' | 'client';
  /** The approved version a change is measured against. */
  parentVersion: number | null;
  plan: Plan;
  checks: PlanChecks;
  bases: PlanBases | null;
  decisionNote: string | null;
  proposedAt: number;
  decidedAt: number | null;
  /** Worked out in main for the card: the change against `parentVersion`. */
  diff: PlanDiffEntry[];
  /** For a proposed change, what approving it would do. */
  effects: PlanEffects | null;
};

export type StepStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'interrupted'
  /** Its crew member left before it was done: the client closed the pane. */
  | 'stopped'
  /** Its crew member's runtime exited before it was done. */
  | 'failed'
  | 'done'
  | 'removed';

export type AgencyStep = {
  jobId: number;
  id: string;
  role: string;
  position: number;
  status: StepStatus;
  addedIn: number;
  removedIn: number | null;
  note: string;
  updatedAt: number;
  finishedAt: number | null;
};

/** One line of a job's record: a progress note, a step move, a decision. */
export type AgencyJobLogEntry = {
  id: number;
  at: number;
  kind: string;
  stepId: string | null;
  text: string;
};

/** A file a result handed back, as copied into the job's results folder. */
export type ResultFile = { name: string; path: string; type: string; size: number };

/** A pull request as GitHub last reported it. */
export type PrState = {
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  headSha: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: { passed: number; failed: number; pending: number };
  /** What an open PR waits on and its open bot comments; absent until read. */
  review?: PrReview;
};

/** What a result holds, by the way its kind is shown. */
export type ResultBody =
  | { kind: 'pr'; pr: PrState }
  | { kind: 'branch'; branch: string; sha: string }
  | { kind: 'copy'; text: string }
  | { kind: 'preview' | 'link'; url: string }
  | { kind: FileResultKind; files: ResultFile[] };

/** The deliverable kinds whose results are files. */
export const FILE_RESULT_KINDS = ['doc', 'image', 'review', 'report', 'file'] as const;
export type FileResultKind = (typeof FILE_RESULT_KINDS)[number];

export function isFileResultKind(kind: string): kind is FileResultKind {
  return FILE_RESULT_KINDS.some((k) => k === kind);
}

/** Something a step handed back, shown as a result card. */
export type AgencyResult = {
  id: number;
  jobId: number;
  stepId: string;
  kind: DeliverableKind;
  label: string;
  /** False for a result the step did not list: an extra. */
  listed: boolean;
  title: string;
  /** For a PR, as last refreshed: the head and diff stat may differ from delivery. */
  body: ResultBody;
  /** A PR whose head moved since it was delivered. */
  changedAfterDelivery: boolean;
  deliveredAt: number;
  /** The project member it came from; null for one with no member, such as a copied text. */
  member: string | null;
  /** Where a PR stands in the job's merge, once the client asked for one. */
  merge: { status: ResultMergeStatus; sha: string | null } | null;
};

export type ResultMergeStatus = 'queued' | 'merged' | 'failed';

/**
 * The client's merge of a job's PRs, one at a time in member order. `note`
 * says what it waits on, or why it stopped.
 */
export type AgencyMergeRun = { status: 'running' | 'failed' | 'done'; note: string };

/**
 * A crew member as the CREW section shows it. `starting` until its runtime
 * reports, `live` after, and `ended` once its pane is gone for good.
 */
export type AgencyCrewMember = {
  id: number;
  stepId: string;
  role: string;
  runtime: CrewRuntime;
  model: string | null;
  /** `<role> <n>`, which names its pane. */
  label: string;
  paneId: string | null;
  status: 'starting' | 'live' | 'ended';
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
};

/** A server a crew member started on a port of its job workspace's block, as SERVERS shows it. */
export type AgencyServer = {
  stepId: string;
  /** The port variable set to its port, or null for another port of the block. */
  name: string | null;
  port: number;
  url: string;
};

export type AgencyJobDetail = {
  job: AgencyJob;
  /** Every version, oldest first. */
  versions: AgencyPlanVersion[];
  /** Steps in plan order, removed ones last. */
  steps: AgencyStep[];
  events: AgencyJobEvent[];
  log: AgencyJobLogEntry[];
  /** Oldest first. */
  results: AgencyResult[];
  spendUsd: number;
  merge: AgencyMergeRun | null;
  /** Every crew member the job hired, oldest first. */
  crew: AgencyCrewMember[];
  /** Servers listening in the blocks of workspaces with crew at work, by port. */
  servers: AgencyServer[];
};

/** The client opens a delivered file with the app their system picks for it. */
export type ResultOpen = { resultId: number; file: number };

export type ResourceStatus = 'planned' | 'live' | 'cleaned' | 'kept' | 'failed' | 'dismissed';

/** The client ends a job: cancel it, or accept what it delivered. */
export type JobControl = { jobId: number; action: 'cancel' | 'accept' };

export type JobControlResult = { ok: true } | { ok: false; reason: string };

export type LeftoverAction = { resourceId: number; action: 'retry' | 'dismiss' };

export type PlanAction =
  | {
      planVersionId: number;
      action: 'approve';
      /** Per member: start from the default branch tip (the default) or the current HEAD. */
      baseChoice?: Record<string, 'default' | 'head'>;
      /** Per swapped running step: keep its work, or start over on a new branch. */
      swaps?: Record<string, SwapChoice>;
    }
  | { planVersionId: number; action: 'reject'; note: string }
  | { planVersionId: number; action: 'edit'; plan: PlanInput };

export type PlanActionResult =
  | { ok: true; version: number }
  | { ok: false; reason: string; newestVersion?: number };
