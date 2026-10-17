import type { JobState } from '../../../shared/agency';

/** How a closing job ends once its cleanup is done. */
export type CloseTarget = 'closed' | 'cancelled' | 'failed';

/**
 * What can happen to a job. Each event names a cause, not a target state: the
 * table below decides where it leads from where the job is.
 */
export type JobEvent =
  | { type: 'plan_proposed' }
  | { type: 'plan_approved' }
  | { type: 'plan_rejected' }
  | { type: 'blocked' }
  | { type: 'unblocked' }
  | { type: 'delivered' }
  | { type: 'follow_up' }
  | { type: 'accepted' }
  | { type: 'cancel' }
  | { type: 'fail' }
  | { type: 'interrupt' }
  | { type: 'resume' }
  | { type: 'cleanup_done'; target: CloseTarget };

export type JobEventType = JobEvent['type'];

export type Transition =
  | { ok: true; from: JobState; to: JobState; changed: boolean; closeTarget?: CloseTarget }
  | { ok: false; refused: string };

/** States a job can still be cancelled from. */
export const OPEN_JOB_STATES: readonly JobState[] = [
  'briefing',
  'planned',
  'running',
  'waiting',
  'delivered',
  'interrupted'
];

type Edge = { from: JobState; event: JobEventType; to: JobState };

/**
 * Every allowed move, one row per edge, as design 14 lists them. A row whose
 * `to` equals its `from` is allowed and changes nothing: a second plan while
 * one waits, an approved plan change on a running job, a second close.
 */
export const JOB_TRANSITIONS: readonly Edge[] = [
  { from: 'briefing', event: 'plan_proposed', to: 'planned' },
  { from: 'planned', event: 'plan_proposed', to: 'planned' },
  { from: 'running', event: 'plan_proposed', to: 'running' },
  { from: 'waiting', event: 'plan_proposed', to: 'waiting' },
  { from: 'delivered', event: 'plan_proposed', to: 'delivered' },
  { from: 'interrupted', event: 'plan_proposed', to: 'interrupted' },

  { from: 'planned', event: 'plan_approved', to: 'running' },
  { from: 'delivered', event: 'plan_approved', to: 'running' },
  { from: 'running', event: 'plan_approved', to: 'running' },
  { from: 'waiting', event: 'plan_approved', to: 'waiting' },
  { from: 'interrupted', event: 'plan_approved', to: 'interrupted' },

  { from: 'planned', event: 'plan_rejected', to: 'briefing' },

  { from: 'running', event: 'blocked', to: 'waiting' },
  { from: 'waiting', event: 'unblocked', to: 'running' },
  { from: 'running', event: 'delivered', to: 'delivered' },
  { from: 'delivered', event: 'follow_up', to: 'running' },
  { from: 'delivered', event: 'accepted', to: 'closing' },

  ...OPEN_JOB_STATES.flatMap((from): Edge[] => [
    { from, event: 'cancel', to: 'closing' },
    { from, event: 'fail', to: 'closing' }
  ]),
  // A second cancel, close or failure joins the cleanup already running.
  { from: 'closing', event: 'cancel', to: 'closing' },
  { from: 'closing', event: 'fail', to: 'closing' },
  { from: 'closing', event: 'accepted', to: 'closing' },

  { from: 'running', event: 'interrupt', to: 'interrupted' },
  // A waiting job is a running one with a hold, and its crew are lost the same way.
  { from: 'waiting', event: 'interrupt', to: 'interrupted' },
  { from: 'interrupted', event: 'resume', to: 'running' },

  { from: 'closing', event: 'cleanup_done', to: 'closed' }
];

const CLOSE_TARGET: Partial<Record<JobEventType, CloseTarget>> = {
  accepted: 'closed',
  cancel: 'cancelled',
  fail: 'failed'
};

/**
 * Where `event` takes a job in `state`, or why it cannot. Pure: the store
 * writes the result with the time and the reason.
 */
export function reduceJob(state: JobState, event: JobEvent): Transition {
  const edge = JOB_TRANSITIONS.find((e) => e.from === state && e.event === event.type);
  if (!edge) return { ok: false, refused: `a ${state} job does not take ${event.type}` };
  // Cleanup ends the job the way its close asked for, not always `closed`.
  const to = event.type === 'cleanup_done' ? event.target : edge.to;
  const closeTarget = state === 'closing' ? undefined : CLOSE_TARGET[event.type];
  return { ok: true, from: state, to, changed: to !== state, closeTarget };
}

/** The events a job in `state` takes. */
export function allowedEvents(state: JobState): JobEventType[] {
  return JOB_TRANSITIONS.filter((e) => e.from === state).map((e) => e.event);
}

/** Whether a job in `state` takes a new plan version. */
export function acceptsPlans(state: JobState): boolean {
  return allowedEvents(state).includes('plan_proposed');
}
