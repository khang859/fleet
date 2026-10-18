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
});
