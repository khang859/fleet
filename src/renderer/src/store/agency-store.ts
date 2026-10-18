import { useEffect } from 'react';
import { create } from 'zustand';
import {
  RUNNING_JOB_STATES,
  type AgencyAnswerRequest,
  type AgencyJob,
  type AgencyQuestion,
  type AgencySnapshot
} from '../../../shared/agency';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  JobControl,
  JobControlResult,
  LeftoverAction,
  PlanAction,
  PlanActionResult
} from '../../../shared/agency-jobs';
import { createLogger } from '../logger';

const log = createLogger('store:agency');

/**
 * The renderer's copy of each repository's agency state: its open jobs and
 * the questions on them, as main last described them.
 *
 * A mirror, like the schedules on a thread: main owns `agency.db`, and every
 * write there raises a change event that the Admiral runtime answers with a
 * `refresh`. Everything an Admiral pane draws outside its transcript - the job
 * tabs, the job sheet, the question cards, the badge - is read from here.
 */
type AgencyStoreState = {
  snapshots: Partial<Record<string, AgencySnapshot>>;
  /** Plan versions, steps and record of the jobs a pane has shown, by job id. */
  details: Partial<Record<number, AgencyJobDetail>>;
  /** Read one job's detail again. */
  loadDetail: (jobId: number) => Promise<AgencyJobDetail | null>;
  /** Read again the details already held for these jobs; others load when shown. */
  reloadDetails: (jobIds: Array<number | null>) => void;
  /** The client's approve, edit or reject on a plan card. */
  decidePlan: (jobId: number, action: PlanAction) => Promise<PlanActionResult>;
  /** Read a repository's state again. Resolves with what was stored, or null when the read failed. */
  refresh: (repoId: string) => Promise<AgencySnapshot | null>;
  /** Answer a question with an option, a free answer, or both. Null when it could not take it. */
  answer: (req: AgencyAnswerRequest) => Promise<AgencyQuestion | null>;
  /** Cancel a repository's running jobs. Resolves with the cancelled ids. */
  cancelJobs: (repoId: string) => Promise<number[]>;
  /** Cancel one job, or accept its results. Either way it closes and cleans up. */
  closeJob: (repoId: string, control: JobControl) => Promise<JobControlResult>;
  /** Merge a delivered job's PRs in member order. */
  mergePrs: (repoId: string, jobId: number) => Promise<JobControlResult>;
  /** Retry or dismiss a leftover of a closed job's cleanup. */
  leftover: (repoId: string, action: LeftoverAction) => Promise<void>;
};

/**
 * The newest read per repository. A refresh that lands after a newer one has
 * already been stored is about an older state and is dropped.
 */
const reads = new Map<string, number>();
/** The same, per job detail. */
const detailReads = new Map<number, number>();

export const useAgencyStore = create<AgencyStoreState>((set, get) => ({
  snapshots: {},
  details: {},

  loadDetail: async (jobId) => {
    const ticket = (detailReads.get(jobId) ?? 0) + 1;
    detailReads.set(jobId, ticket);
    let detail: AgencyJobDetail | null;
    try {
      detail = await window.fleet.agency.jobDetail(jobId);
    } catch (err) {
      log.warn('job detail failed', { jobId, error: String(err) });
      return null;
    }
    if (detailReads.get(jobId) !== ticket) return get().details[jobId] ?? null;
    set((s) => ({ details: { ...s.details, [jobId]: detail ?? undefined } }));
    return detail;
  },

  reloadDetails: (jobIds) => {
    for (const jobId of jobIds) {
      if (jobId !== null && get().details[jobId] !== undefined) void get().loadDetail(jobId);
    }
  },

  decidePlan: async (jobId, action) => {
    const result = await window.fleet.agency.planAction(action);
    // The change event refreshes the snapshot; a refused action changed nothing
    // there, but the card may be showing a version main has moved past.
    void get().loadDetail(jobId);
    return result;
  },

  refresh: async (repoId) => {
    const ticket = (reads.get(repoId) ?? 0) + 1;
    reads.set(repoId, ticket);
    let snapshot: AgencySnapshot;
    try {
      snapshot = await window.fleet.agency.snapshot(repoId);
    } catch (err) {
      log.warn('snapshot failed', { repoId, error: String(err) });
      return null;
    }
    if (reads.get(repoId) !== ticket) return get().snapshots[repoId] ?? null;
    set((s) => ({ snapshots: { ...s.snapshots, [repoId]: snapshot } }));
    return snapshot;
  },

  answer: async (req) => {
    const answered = await window.fleet.agency.answerQuestion(req);
    if (answered !== null) void get().refresh(answered.repoId);
    return answered;
  },

  cancelJobs: async (repoId) => {
    const ids = await window.fleet.agency.cancelJobs(repoId);
    void get().refresh(repoId);
    return ids;
  },

  closeJob: async (repoId, control) => {
    const result = await window.fleet.agency.jobControl(control);
    void get().refresh(repoId);
    return result;
  },

  mergePrs: async (repoId, jobId) => {
    const result = await window.fleet.agency.mergePrs(jobId);
    void get().refresh(repoId);
    return result;
  },

  leftover: async (repoId, action) => {
    await window.fleet.agency.leftover(action);
    void get().refresh(repoId);
  }
}));

/**
 * The questions waiting on the client: every open one in the repository, or
 * only one job's (null: the lobby's) when `jobId` is given.
 */
export function openQuestions(
  snapshot: AgencySnapshot | undefined,
  jobId?: number | null
): AgencyQuestion[] {
  if (snapshot === undefined) return [];
  return snapshot.questions.filter(
    (q) => q.status === 'open' && (jobId === undefined || q.jobId === jobId)
  );
}

/**
 * How many things wait on the client: open questions, plan versions to
 * decide and delivered jobs to accept, in the repository or one job (null:
 * the lobby, which has no plans).
 */
export function waitingCount(snapshot: AgencySnapshot | undefined, jobId?: number | null): number {
  if (snapshot === undefined) return 0;
  const jobs = snapshot.jobs.filter((j) => jobId === undefined || j.id === jobId);
  const plans = jobs.filter((j) => j.pendingPlan !== null).length;
  const delivered = jobs.filter((j) => j.state === 'delivered').length;
  const crew = jobs.reduce((n, j) => n + j.crewNeedingYou + j.permissionsWaiting.length, 0);
  return openQuestions(snapshot, jobId).length + plans + delivered + crew;
}

/** The plan versions a job's sheet shows: the one waiting on the client and the one it runs. */
export function planVersions(detail: AgencyJobDetail | undefined): {
  pending: AgencyPlanVersion | null;
  approved: AgencyPlanVersion | null;
} {
  const versions = detail?.versions ?? [];
  return {
    pending: versions.find((v) => v.status === 'proposed') ?? null,
    approved: versions.find((v) => v.status === 'approved') ?? null
  };
}

/** Jobs that closing the pane or quitting would leave running unattended. */
export function runningJobs(snapshot: AgencySnapshot | undefined): AgencyJob[] {
  return snapshot === undefined ? [] : snapshot.jobs.filter((j) => isRunningJob(j));
}

export function isRunningJob(job: Pick<AgencyJob, 'state'>): boolean {
  return RUNNING_JOB_STATES.includes(job.state);
}

export function findQuestion(
  snapshot: AgencySnapshot | undefined,
  id: number
): AgencyQuestion | null {
  return snapshot?.questions.find((q) => q.id === id) ?? null;
}

export function findJob(snapshot: AgencySnapshot | undefined, id: number): AgencyJob | null {
  return snapshot?.jobs.find((j) => j.id === id) ?? null;
}

/**
 * A job's detail, loaded the first time a view asks for it and kept fresh by
 * the change events after that. Undefined until it arrives.
 */
export function useJobDetail(jobId: number | null): AgencyJobDetail | undefined {
  const detail = useAgencyStore((s) => (jobId === null ? undefined : s.details[jobId]));
  const missing = jobId !== null && detail === undefined;
  useEffect(() => {
    if (missing) void useAgencyStore.getState().loadDetail(jobId);
  }, [missing, jobId]);
  return detail;
}

/**
 * The job detail, among those held, whose `items` hold one with `id`. Returns
 * the stored detail itself, so a store selector built on it stays stable.
 */
export function detailHolding<T extends { id: number }>(
  details: Partial<Record<number, AgencyJobDetail>>,
  items: (detail: AgencyJobDetail) => T[],
  id: number
): AgencyJobDetail | null {
  return (
    Object.values(details).find(
      (detail) => detail !== undefined && items(detail).some((item) => item.id === id)
    ) ?? null
  );
}
