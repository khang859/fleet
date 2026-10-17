import { create } from 'zustand';
import {
  RUNNING_JOB_STATES,
  type AgencyAnswerRequest,
  type AgencyJob,
  type AgencyQuestion,
  type AgencySnapshot
} from '../../../shared/agency';
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
  /** Read a repository's state again. Resolves with what was stored, or null when the read failed. */
  refresh: (repoId: string) => Promise<AgencySnapshot | null>;
  /** Answer a question with an option, a free answer, or both. Null when it could not take it. */
  answer: (req: AgencyAnswerRequest) => Promise<AgencyQuestion | null>;
  /** Cancel a repository's running jobs. Resolves with the cancelled ids. */
  cancelJobs: (repoId: string) => Promise<number[]>;
};

/**
 * The newest read per repository. A refresh that lands after a newer one has
 * already been stored is about an older state and is dropped.
 */
const reads = new Map<string, number>();

export const useAgencyStore = create<AgencyStoreState>((set, get) => ({
  snapshots: {},

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
