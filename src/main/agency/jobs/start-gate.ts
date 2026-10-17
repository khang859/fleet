import { jobDisplayId, type AgencyJob } from '../../../shared/agency';
import type { AgencyStep } from '../../../shared/agency-jobs';
import type { Plan } from '../../../shared/agency-plan';

export type StartVerdict = { ok: true } | { ok: false; reason: string; queue?: boolean };

/**
 * Whether a step may start now: hiring its crew and creating its worktrees
 * both ask this first, so nothing starts before the plan is approved, outside
 * it, or ahead of the steps it waits on.
 *
 * Refused while the job is not running (a `closing` job included), when the
 * approved plan has no such step, and while a step it waits on is not done.
 * Over the crew limit, or behind a job it queues after, it is not refused but
 * queued: it starts once a place frees up.
 */
export function canStartStep(input: {
  job: Pick<AgencyJob, 'id' | 'state'>;
  plan: Plan | null;
  steps: AgencyStep[];
  stepId: string;
  /** The job this one runs after, while that job is still under way. */
  queuedBehind?: number | null;
  live?: { job: number; all: number; limit: number };
}): StartVerdict {
  const id = jobDisplayId(input.job.id);
  if (input.job.state !== 'running') {
    return { ok: false, reason: `${id} is ${input.job.state}; work starts only while it runs.` };
  }
  const step = input.plan?.steps.find((s) => s.id === input.stepId);
  if (input.plan === null || !step) {
    return {
      ok: false,
      reason: `Step ${input.stepId} is not in the approved plan. Propose a plan change first.`
    };
  }
  const row = input.steps.find((s) => s.id === input.stepId);
  if (row?.status === 'removed' || row?.status === 'done') {
    return { ok: false, reason: `Step ${input.stepId} is ${row.status}.` };
  }
  const waiting = step.after.filter(
    (dep) => input.steps.find((s) => s.id === dep)?.status !== 'done'
  );
  if (waiting.length > 0) {
    return { ok: false, reason: `Step ${input.stepId} waits on ${waiting.join(', ')}.` };
  }
  if (input.queuedBehind != null) {
    return {
      ok: false,
      reason: `${id} runs after ${jobDisplayId(input.queuedBehind)}, which is still under way.`,
      queue: true
    };
  }
  const live = input.live;
  if (live && (live.job >= live.limit || live.all >= live.limit)) {
    return {
      ok: false,
      reason: `${live.limit} crew members are already working; this step starts when one finishes.`,
      queue: true
    };
  }
  return { ok: true };
}
