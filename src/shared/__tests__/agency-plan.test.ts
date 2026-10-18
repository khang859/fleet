import { describe, expect, it } from 'vitest';
import {
  PlanSchema,
  diffLine,
  diffPlans,
  scopeProblems,
  validatePlanGraph,
  type PlanInput
} from '../agency-plan';

const BASE: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode.',
  steps: [
    { id: 'builder-1', role: 'builder', title: 'Build' },
    { id: 'reviewer', role: 'reviewer', title: 'Review', after: ['builder-1'] }
  ],
  budget: { usd: 10 }
};

const plan = (patch: Partial<PlanInput> = {}): ReturnType<typeof PlanSchema.parse> =>
  PlanSchema.parse({ ...BASE, ...patch });

describe('PlanSchema', () => {
  it('fills defaults and turns a bare deliverable kind into its default label', () => {
    const parsed = plan({
      steps: [
        {
          id: 'a',
          role: 'builder',
          title: 'A',
          deliverables: ['pr', { kind: 'doc', label: 'Spec' }]
        }
      ]
    });
    expect(parsed.queueBehind).toBeNull();
    expect(parsed.asksFirst).toEqual([]);
    expect(parsed.steps[0]).toMatchObject({ after: [], changes: [], reads: [], paths: [] });
    expect(parsed.steps[0].deliverables).toEqual([
      { kind: 'pr', label: 'Branch and PR' },
      { kind: 'doc', label: 'Spec' }
    ]);
  });

  it('refuses a step id that is not a slug', () => {
    const result = PlanSchema.safeParse({
      ...BASE,
      steps: [{ id: 'Builder 1', role: 'b', title: 'B' }]
    });
    expect(result.success).toBe(false);
  });
});

describe('validatePlanGraph', () => {
  it('finds duplicates and unknown steps', () => {
    const problems = validatePlanGraph(
      plan({
        steps: [
          { id: 'a', role: 'b', title: 'A' },
          { id: 'a', role: 'b', title: 'A again' },
          { id: 'd', role: 'b', title: 'D', after: ['ghost'] }
        ]
      })
    );
    expect(problems).toEqual([
      'Step a is listed twice.',
      'Step d waits on ghost, which is not in the plan.'
    ]);
  });

  it('finds steps that wait on each other', () => {
    const problems = validatePlanGraph(
      plan({
        steps: [
          { id: 'a', role: 'b', title: 'A', after: ['c'] },
          { id: 'c', role: 'b', title: 'C', after: ['a'] }
        ]
      })
    );
    expect(problems).toEqual(['Steps wait on each other in a loop: a -> c -> a.']);
  });

  it('is empty for a fine plan', () => {
    expect(validatePlanGraph(plan())).toEqual([]);
  });

  it('wants a workspace of a step the step waits for, and one that made a worktree', () => {
    const problems = validatePlanGraph(
      plan({
        steps: [
          { id: 'build', role: 'b', title: 'Build' },
          { id: 'join', role: 'b', title: 'Join', workspace: { integrate: ['build'] } },
          {
            id: 'review',
            role: 'b',
            title: 'Review',
            after: ['build'],
            workspace: { of: 'ghost' }
          },
          { id: 'qa', role: 'b', title: 'QA', after: ['build'], workspace: { of: 'build' } },
          { id: 'look', role: 'b', title: 'Look', after: ['qa'], workspace: { of: 'qa' } }
        ]
      })
    );
    expect(problems).toEqual([
      "Step join works in build's output, so it has to wait for build.",
      "Step review works in ghost's output, which is not in the plan.",
      "Step look reads qa's worktree, but qa works in another step's. Read that one."
    ]);
  });
});

describe('scopeProblems', () => {
  const steps = (...list: PlanInput['steps']): ReturnType<typeof PlanSchema.parse>['steps'] =>
    plan({ steps: list }).steps;

  it('wants a scope each for side-by-side steps that hand back code in one member', () => {
    expect(
      scopeProblems(
        steps(
          { id: 'a', role: 'b', title: 'A', deliverables: ['branch'] },
          { id: 'b', role: 'b', title: 'B', scope: 'x' },
          { id: 'join', role: 'b', title: 'Join', after: ['a', 'b'], deliverables: ['pr'] }
        )
      )
    ).toEqual(['Steps a and b change the same code side by side, so each needs its own scope.']);
  });

  it('lets a doc step, a step in another member, and a later step go without scopes', () => {
    expect(
      scopeProblems(
        steps(
          { id: 'build', role: 'b', title: 'Build', changes: ['web'], deliverables: ['pr'] },
          { id: 'api', role: 'b', title: 'API', changes: ['api'], deliverables: ['pr'] },
          { id: 'notes', role: 'w', title: 'Notes', deliverables: ['doc'] },
          {
            id: 'fix',
            role: 'b',
            title: 'Fix',
            after: ['build'],
            changes: ['web'],
            deliverables: ['pr']
          }
        )
      )
    ).toEqual([]);
  });

  it('wants a later merge for a scoped step with no branch of its own', () => {
    expect(scopeProblems(steps({ id: 'a', role: 'b', title: 'A', scope: 'x' }))).toEqual([
      'Step a has a scope, so a later step has to merge its branch, or it hands back its own branch or PR.'
    ]);
  });
});

describe('diffPlans', () => {
  it('has no diff for a first plan', () => {
    expect(diffPlans(null, plan())).toEqual([]);
  });

  it('names added, removed, changed and moved steps, and the budget', () => {
    const next = plan({
      steps: [
        { id: 'tester', role: 'tester', title: 'Test' },
        { id: 'builder-1', role: 'senior-builder', title: 'Build' }
      ],
      budget: { usd: 15 }
    });
    const diff = diffPlans(plan(), next);
    expect(diff).toEqual([
      { kind: 'removed', step: 'reviewer' },
      { kind: 'added', step: 'tester' },
      { kind: 'changed', step: 'builder-1', fields: ['role'] },
      { kind: 'budget', from: 10, to: 15 }
    ]);
    expect(diff.map(diffLine)).toEqual([
      'Removes reviewer',
      'Adds tester',
      'Changes builder-1: role',
      'Budget $10 to $15'
    ]);
  });

  it('sees a reorder of kept steps as a move', () => {
    const next = plan({ steps: [{ ...BASE.steps[1], after: [] }, BASE.steps[0]] });
    expect(diffPlans(plan(), next)).toEqual([
      { kind: 'changed', step: 'reviewer', fields: ['after'] },
      { kind: 'moved', step: 'reviewer' },
      { kind: 'moved', step: 'builder-1' }
    ]);
  });
});
