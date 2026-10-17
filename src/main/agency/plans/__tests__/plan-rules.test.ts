import { describe, expect, it } from 'vitest';
import type { AgencyStep, StepStatus } from '../../../../shared/agency-jobs';
import { PlanSchema, type PlanInput } from '../../../../shared/agency-plan';
import { canDecide, lockedViolations, missingDeliverables, stepsToRemove } from '../plan-rules';
import type { PlanVersionRecord } from '../../store/plan-store';

const BASE: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode.',
  steps: [
    { id: 'a', role: 'builder', title: 'A', deliverables: ['pr'] },
    { id: 'b', role: 'reviewer', title: 'B', after: ['a'] }
  ],
  budget: { usd: 10 }
};
const plan = (patch: Partial<PlanInput> = {}): ReturnType<typeof PlanSchema.parse> =>
  PlanSchema.parse({ ...BASE, ...patch });

function step(id: string, status: StepStatus): AgencyStep {
  return {
    jobId: 1,
    id,
    role: 'builder',
    position: 0,
    status,
    addedIn: 1,
    removedIn: null,
    note: '',
    updatedAt: 0,
    finishedAt: null
  };
}

const version = (id: number, v: number, status: PlanVersionRecord['status']): PlanVersionRecord =>
  ({ id, jobId: 1, version: v, status }) as PlanVersionRecord;

describe('lockedViolations', () => {
  it('lets anything change before a plan is approved, except the budget floor', () => {
    expect(
      lockedViolations({
        approved: null,
        next: plan({ budget: { usd: 1 } }),
        steps: [],
        delivered: [],
        spendUsd: 2
      })
    ).toEqual(['The budget cannot go below what the job already spent ($2.00).']);
  });

  it('locks a done step and a step that delivered', () => {
    const problems = lockedViolations({
      approved: plan(),
      next: plan({
        steps: [{ id: 'a', role: 'builder', title: 'A changed', deliverables: ['pr'] }]
      }),
      steps: [step('a', 'done'), step('b', 'running')],
      delivered: [{ stepId: 'b', kind: 'review', label: 'Review notes' }],
      spendUsd: 0
    });
    expect(problems).toEqual([
      'Step a is done, so it cannot change.',
      'Step b already delivered results, so it cannot be removed.'
    ]);
  });
});

describe('stepsToRemove', () => {
  it('drops live steps the new plan leaves out, but never a done one', () => {
    const next = plan({ steps: [BASE.steps[0]] });
    expect(stepsToRemove([step('a', 'running'), step('b', 'pending')], next)).toEqual(['b']);
    expect(stepsToRemove([step('a', 'running'), step('b', 'done')], next)).toEqual([]);
  });
});

describe('canDecide', () => {
  it('takes only the newest version while it waits', () => {
    expect(canDecide(version(2, 2, 'proposed'), version(2, 2, 'proposed'))).toEqual({ ok: true });
    expect(canDecide(version(1, 1, 'replaced'), version(2, 2, 'proposed'))).toEqual({
      ok: false,
      reason: 'Plan v1 was replaced by v2.',
      newestVersion: 2
    });
    expect(canDecide(version(2, 2, 'approved'), version(2, 2, 'approved'))).toEqual({
      ok: false,
      reason: 'Plan v2 is already approved.'
    });
    expect(canDecide(null, null)).toMatchObject({ ok: false });
  });
});

describe('missingDeliverables', () => {
  it('lists what live steps owe, and skips removed steps', () => {
    const steps = [step('a', 'done'), step('b', 'done')];
    expect(missingDeliverables(plan(), steps, [])).toEqual(['a lists "Branch and PR" (pr)']);
    expect(missingDeliverables(plan(), steps, [{ stepId: 'a', kind: 'pr', label: 'PR' }])).toEqual(
      []
    );
    expect(missingDeliverables(plan(), [step('a', 'removed'), step('b', 'done')], [])).toEqual([]);
  });
});
