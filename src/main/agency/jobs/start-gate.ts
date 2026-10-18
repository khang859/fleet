import { jobDisplayId, type AgencyJob } from '../../../shared/agency';
import { RUNTIME_LABEL, type CrewRuntime } from '../../../shared/agency-crew';
import type { AgencyStep } from '../../../shared/agency-jobs';
import type { Plan } from '../../../shared/agency-plan';
import type { StackGate } from './stack-slots';

export type StartVerdict = { ok: true } | { ok: false; reason: string; queue?: boolean };

/**
 * Whether a step may start now: hiring its crew and creating its worktrees
 * both ask this first, so nothing starts before the plan is approved, outside
 * it, or ahead of the steps it waits on.
 *
 * Refused while the job is not running (a `closing` job included), when the
 * approved plan has no such step, while a step it waits on is not done, and
 * for a step its crew member left before it was done, until the client says
 * it may go again.
 * Over its runtime's crew limit, behind a job it queues after, or with every stack slot
 * taken, it is not refused but queued: it starts once a place frees up.
 */
export function canStartStep(input: {
  job: Pick<AgencyJob, 'id' | 'state'>;
  plan: Plan | null;
  steps: AgencyStep[];
  stepId: string;
  /** The job this one runs after, while that job is still under way. */
  queuedBehind?: number | null;
  /** Crew of the step's runtime working now, across jobs, and how many may. */
  live?: { runtime: CrewRuntime; working: number; limit: number };
  /** The project's stack slots, for a step whose role runs the stack. */
  stack?: StackGate | null;
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
  if (row?.status === 'stopped' || row?.status === 'failed') {
    return {
      ok: false,
      reason: `Step ${input.stepId} ${row.status === 'stopped' ? 'was stopped' : 'failed'} before it was done, so it starts again only with the client's OK. Fleet asked them; their answer arrives as a wakeup.`
    };
  }
  const waiting = step.after.filter(
    (dep) => input.steps.find((s) => s.id === dep)?.status !== 'done'
  );
  if (waiting.length > 0) {
    return { ok: false, reason: `Step ${input.stepId} waits on ${waiting.join(', ')}.` };
  }
  const wait = waitReason(input);
  return wait === null ? { ok: true } : { ok: false, reason: wait, queue: true };
}

/** Why a step that may start has to wait for a place first, or null when it can go now. */
function waitReason(input: Parameters<typeof canStartStep>[0]): string | null {
  if (input.queuedBehind != null) {
    return `${jobDisplayId(input.job.id)} runs after ${jobDisplayId(input.queuedBehind)}, which is still under way.`;
  }
  const live = input.live;
  if (live && live.working >= live.limit) {
    const who = `${RUNTIME_LABEL[live.runtime]} crew ${live.limit === 1 ? 'member is' : 'members are'}`;
    return `${live.limit} ${who} already working; this step starts when one finishes.`;
  }
  const stack = input.stack;
  if (!stack || stack.held < stack.slots) return null;
  const outside =
    stack.outsidePort === null
      ? ''
      : ` A program outside Fleet listens on port ${stack.outsidePort}, which takes one; Fleet does not stop it.`;
  return `Waiting for a stack slot: the project runs ${stack.slots === 1 ? 'one stack' : `${stack.slots} stacks`} at a time.${outside}`;
}
