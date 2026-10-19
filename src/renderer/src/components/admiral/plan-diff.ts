import type { PlanVersionStatus } from '../../../../shared/agency-jobs';
import type { Plan, PlanDiffEntry, StepChange } from '../../../../shared/agency-plan';

/** How a step of a version differs from the version before it. */
export type StepMark = {
  added: boolean;
  /** Up or down among the steps both versions keep; null when it kept its place. */
  moved: 'up' | 'down' | null;
  /** What changed in the step, as the client reads it. */
  changed: string[];
};

const FIELD_NAME: Record<StepChange, string> = {
  role: 'role',
  runtime: 'runtime',
  model: 'model',
  title: 'title',
  after: 'waits on',
  deliverables: 'hands back',
  members: 'files',
  workspace: 'workspace',
  skills: 'skills',
  cap: 'cap'
};

/** What a version was, as the line above its changes says: `replaced`. */
export const STATUS_WORD: Record<PlanVersionStatus, string> = {
  proposed: 'waiting',
  approved: 'approved',
  rejected: 'rejected',
  replaced: 'replaced',
  superseded: 'superseded'
};

/**
 * The marks for each step of `plan` that the diff from the version before
 * names. A moved step says up or down when the version before is at hand.
 */
export function stepMarks(
  diff: readonly PlanDiffEntry[],
  plan: Plan,
  before: Plan | undefined
): Map<string, StepMark> {
  const marks = new Map<string, StepMark>();
  const mark = (step: string): StepMark => {
    const found = marks.get(step) ?? { added: false, moved: null, changed: [] };
    marks.set(step, found);
    return found;
  };
  for (const entry of diff) {
    if (entry.kind === 'added') mark(entry.step).added = true;
    if (entry.kind === 'changed') mark(entry.step).changed = entry.fields.map((f) => FIELD_NAME[f]);
    if (entry.kind === 'moved') mark(entry.step).moved = direction(entry.step, plan, before);
  }
  return marks;
}

/** Up or down among the steps both plans keep; up when the plan before is not at hand. */
function direction(step: string, plan: Plan, before: Plan | undefined): 'up' | 'down' {
  if (before === undefined) return 'up';
  const now = new Set(plan.steps.map((s) => s.id));
  const then = new Set(before.steps.map((s) => s.id));
  const keptNow = plan.steps.filter((s) => then.has(s.id)).map((s) => s.id);
  const keptThen = before.steps.filter((s) => now.has(s.id)).map((s) => s.id);
  return keptNow.indexOf(step) < keptThen.indexOf(step) ? 'up' : 'down';
}

/** The steps the version before had and this one drops, by title when the version before is at hand. */
export function removedSteps(
  diff: readonly PlanDiffEntry[],
  before: Plan | undefined
): Array<{ id: string; title: string }> {
  return diff.flatMap((entry) => {
    if (entry.kind !== 'removed') return [];
    const step = before?.steps.find((s) => s.id === entry.step);
    return [{ id: entry.step, title: step?.title ?? entry.step }];
  });
}

/** The number of steps the version before had. */
export function stepCountBefore(diff: readonly PlanDiffEntry[], plan: Plan): number {
  const count = (kind: 'added' | 'removed'): number => diff.filter((e) => e.kind === kind).length;
  return plan.steps.length - count('added') + count('removed');
}

/** The old budget and week share where the diff changed them. */
export function budgetBefore(diff: readonly PlanDiffEntry[]): {
  usd?: number;
  weekPct?: number | null;
} {
  const budget = diff.find((e) => e.kind === 'budget');
  const week = diff.find((e) => e.kind === 'week_share');
  return {
    ...(budget === undefined ? {} : { usd: budget.from }),
    ...(week === undefined ? {} : { weekPct: week.from })
  };
}

/** The colour of a step's left edge: green when new, blue when moved or changed. */
export function markEdge(mark: StepMark | undefined): string {
  if (mark?.added === true) return 'border-l-green-500';
  if (mark !== undefined && (mark.moved !== null || mark.changed.length > 0)) {
    return 'border-l-blue-400';
  }
  return 'border-l-transparent';
}

/** `ids` with `id` added, or taken out when it is there. */
export function toggled(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
}
