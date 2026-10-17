import { describe, expect, it } from 'vitest';
import type { JobState } from '../../../../shared/agency';
import { acceptsPlans, reduceJob, type JobEvent, type JobEventType } from '../job-machine';

const STATES: JobState[] = [
  'briefing',
  'planned',
  'running',
  'waiting',
  'delivered',
  'closing',
  'closed',
  'cancelled',
  'failed',
  'interrupted'
];
const EVENTS: JobEventType[] = [
  'plan_proposed',
  'plan_approved',
  'plan_rejected',
  'blocked',
  'unblocked',
  'delivered',
  'follow_up',
  'accepted',
  'cancel',
  'fail',
  'interrupt',
  'resume',
  'cleanup_done'
];
const OPEN: JobState[] = ['briefing', 'planned', 'running', 'waiting', 'delivered', 'interrupted'];

function event(type: JobEventType): JobEvent {
  return type === 'cleanup_done' ? { type, target: 'cancelled' } : { type };
}

/**
 * Design 14, written out by hand: every move that changes the state. Anything
 * else either keeps the state (listed in SAME) or is refused.
 */
const MOVES: Array<[JobState, JobEventType, JobState]> = [
  ['briefing', 'plan_proposed', 'planned'],
  ['planned', 'plan_approved', 'running'],
  ['planned', 'plan_rejected', 'briefing'],
  ['running', 'blocked', 'waiting'],
  ['waiting', 'unblocked', 'running'],
  ['running', 'delivered', 'delivered'],
  ['delivered', 'follow_up', 'running'],
  ['delivered', 'plan_approved', 'running'],
  ['delivered', 'accepted', 'closing'],
  ...OPEN.flatMap(
    (s): Array<[JobState, JobEventType, JobState]> => [
      [s, 'cancel', 'closing'],
      [s, 'fail', 'closing']
    ]
  ),
  ['closing', 'cleanup_done', 'cancelled'],
  ['running', 'interrupt', 'interrupted'],
  ['waiting', 'interrupt', 'interrupted'],
  ['interrupted', 'resume', 'running']
];

/** Allowed, and change nothing: a new plan version while one is out, a second close. */
const SAME: Array<[JobState, JobEventType]> = [
  ['planned', 'plan_proposed'],
  ['running', 'plan_proposed'],
  ['waiting', 'plan_proposed'],
  ['delivered', 'plan_proposed'],
  ['interrupted', 'plan_proposed'],
  ['running', 'plan_approved'],
  ['waiting', 'plan_approved'],
  ['interrupted', 'plan_approved'],
  ['closing', 'cancel'],
  ['closing', 'fail'],
  ['closing', 'accepted']
];

describe('job state machine', () => {
  const cases = STATES.flatMap((s) => EVENTS.map((e) => [s, e] as const));

  it.each(cases)('%s + %s', (state, type) => {
    const result = reduceJob(state, event(type));
    const move = MOVES.find(([s, e]) => s === state && e === type);
    const same = SAME.some(([s, e]) => s === state && e === type);
    if (move) {
      expect(result).toMatchObject({ ok: true, from: state, to: move[2], changed: true });
    } else if (same) {
      expect(result).toMatchObject({ ok: true, to: state, changed: false });
    } else {
      expect(result).toEqual({ ok: false, refused: `a ${state} job does not take ${type}` });
    }
  });

  it('remembers how a close ends, and ends cleanup that way', () => {
    expect(reduceJob('delivered', { type: 'accepted' })).toMatchObject({ closeTarget: 'closed' });
    expect(reduceJob('running', { type: 'cancel' })).toMatchObject({ closeTarget: 'cancelled' });
    expect(reduceJob('waiting', { type: 'fail' })).toMatchObject({ closeTarget: 'failed' });
    // A second close does not change the end.
    expect(reduceJob('closing', { type: 'fail' })).not.toHaveProperty('closeTarget', 'failed');
    expect(reduceJob('closing', { type: 'cleanup_done', target: 'closed' })).toMatchObject({
      to: 'closed'
    });
  });

  it('takes plans in every open state, and never once closing or ended', () => {
    expect(STATES.filter(acceptsPlans)).toEqual(OPEN);
  });
});
