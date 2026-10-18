import { describe, expect, it } from 'vitest';
import type { AgencyStep, StepStatus } from '../../../../shared/agency-jobs';
import { PlanSchema } from '../../../../shared/agency-plan';
import { canStartStep } from '../start-gate';

const plan = PlanSchema.parse({
  playbook: 'feature',
  summary: 's',
  steps: [{ id: 'build', role: 'builder', title: 'Build' }],
  budget: { usd: 5 }
});

const row = (status: StepStatus): AgencyStep => ({
  jobId: 4,
  id: 'build',
  role: 'builder',
  position: 0,
  status,
  addedIn: 1,
  removedIn: null,
  note: '',
  updatedAt: 1,
  finishedAt: null
});

const verdict = (status: StepStatus) =>
  canStartStep({ job: { id: 4, state: 'running' }, plan, steps: [row(status)], stepId: 'build' });

describe('canStartStep', () => {
  it.each(['stopped', 'failed'] as const)(
    'holds a %s step until the client says it may go again',
    (status) => {
      const out = verdict(status);
      expect(out.ok).toBe(false);
      expect(out.ok ? '' : out.reason).toContain("starts again only with the client's OK");
      expect(out.ok ? undefined : out.queue).toBeUndefined();
    }
  );

  it('lets an interrupted step start again, which resumes its crew', () => {
    expect(verdict('interrupted')).toEqual({ ok: true });
  });

  it('queues a stack step while every slot is taken, and starts it when one is free', () => {
    const gate = (held: number, outsidePort: number | null = null) =>
      canStartStep({
        job: { id: 4, state: 'running' },
        plan,
        steps: [row('pending')],
        stepId: 'build',
        stack: { slots: 2, held, outsidePort }
      });
    expect(gate(1)).toEqual({ ok: true });
    expect(gate(2, 5432)).toEqual({
      ok: false,
      reason:
        'Waiting for a stack slot: the project runs 2 stacks at a time. A program outside Fleet listens on port 5432, which takes one; Fleet does not stop it.',
      queue: true
    });
  });
});
