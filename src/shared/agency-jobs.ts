import type { AgencyJob, AgencyJobEvent } from './agency';
import type { Plan, PlanDiffEntry, PlanInput } from './agency-plan';

/**
 * What one job holds beyond its row: its plan versions, its steps and its
 * record. The snapshot stays light and names jobs only; a pane fetches this
 * for the job it shows, and again when a change names that job.
 */

export type PlanVersionStatus = 'proposed' | 'approved' | 'rejected' | 'replaced' | 'superseded';

/** One thing the pre-approval check found. `block` keeps Approve disabled. */
export type PlanIssue = {
  code: string;
  severity: 'warn' | 'block';
  text: string;
  step?: string;
  member?: string;
};

/** Paths this plan and another running job's both expect to touch. */
export type PlanOverlap = { jobId: number; member: string; path: string; step: string };

export type PlanChecks = {
  issues: PlanIssue[];
  overlap: PlanOverlap[];
};

export const NO_PLAN_CHECKS: PlanChecks = { issues: [], overlap: [] };

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

export type AgencyJobDetail = {
  job: AgencyJob;
  /** Every version, oldest first. */
  versions: AgencyPlanVersion[];
  /** Steps in plan order, removed ones last. */
  steps: AgencyStep[];
  events: AgencyJobEvent[];
  log: AgencyJobLogEntry[];
  spendUsd: number;
};

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
