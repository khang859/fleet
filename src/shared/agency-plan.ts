import { z } from 'zod';

/**
 * A job's plan, as the Admiral proposes it with `job_plan` and the client
 * approves, edits or rejects it on the plan card. The Admiral always sends the
 * whole plan; Fleet works out what changed against the approved version.
 */

/**
 * What a step hands back. The kind decides how Fleet shows and checks the
 * result; `file` and `link` cover anything else, so a new kind of result needs
 * no new Fleet code. `branch` is the local-branch fallback for a `pr` that
 * cannot be opened (no GitHub remote, or `gh` not signed in).
 */
export const DELIVERABLE_KINDS = [
  'pr',
  'branch',
  'doc',
  'image',
  'copy',
  'preview',
  'review',
  'report',
  'file',
  'link'
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_DEFAULT_LABEL: Record<DeliverableKind, string> = {
  pr: 'Branch and PR',
  branch: 'Local branch',
  doc: 'Document',
  image: 'Images',
  copy: 'Copy drafts',
  preview: 'Preview link',
  review: 'Review notes',
  report: 'Report with screenshots',
  file: 'File',
  link: 'Link'
};

export type Deliverable = { kind: DeliverableKind; label: string };

const Kind = z.enum(DELIVERABLE_KINDS);

/** A bare kind is short for `{kind}`; a missing label takes the kind's default. */
export const DeliverableSchema = z
  .union([Kind, z.object({ kind: Kind, label: z.string().trim().min(1).max(80).optional() })])
  .transform(
    (d): Deliverable =>
      typeof d === 'string'
        ? { kind: d, label: DELIVERABLE_DEFAULT_LABEL[d] }
        : { kind: d.kind, label: d.label ?? DELIVERABLE_DEFAULT_LABEL[d.kind] }
  );

export const PLAN_MAX_STEPS = 30;
export const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const Slug = z
  .string()
  .regex(STEP_ID_PATTERN, 'a step id is lower-case letters, digits and dashes, like builder-1');
const Member = z.string().trim().min(1).max(200);
const Names = z.array(Member).max(50);

export const PlanStepSchema = z.object({
  /** Stable across versions: the same id is the same step. */
  id: Slug,
  role: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  runtime: z.enum(['claude', 'eva']).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  /** Steps that must be done before this one starts. */
  after: z.array(Slug).max(PLAN_MAX_STEPS).default([]),
  /** Member repositories the step changes, and those it only reads. Empty: every member. */
  changes: Names.default([]),
  reads: Names.default([]),
  /** Paths the step expects to touch, as `member/dir`, for the overlap check. */
  paths: z.array(z.string().trim().min(1).max(400)).max(100).default([]),
  deliverables: z.array(DeliverableSchema).max(10).default([])
});

export const PlanSchema = z.object({
  playbook: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(2_000),
  steps: z.array(PlanStepSchema).min(1).max(PLAN_MAX_STEPS),
  budget: z.object({
    usd: z.number().positive().max(100_000),
    weekPct: z.number().positive().max(100).optional()
  }),
  /** Run this job after that one, rather than next to it. */
  queueBehind: z.number().int().positive().nullable().default(null),
  /** What the Admiral checks with the client before doing it: merge, deploy, deletes. */
  asksFirst: z.array(z.string().trim().min(1).max(200)).max(10).default([])
});

export type PlanStep = z.output<typeof PlanStepSchema>;
export type Plan = z.output<typeof PlanSchema>;
export type PlanInput = z.input<typeof PlanSchema>;

/** The plan with every `pr` deliverable turned into a local branch, for the card's fix. */
export function withLocalBranches(plan: Plan): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      deliverables: step.deliverables.map((d) =>
        d.kind === 'pr' ? { kind: 'branch', label: 'Local branch' } : d
      )
    }))
  };
}

/**
 * What is wrong with a plan's step graph, one sentence each: duplicate ids,
 * `after` naming a step that is not there, and cycles. Empty when it is fine.
 */
export function validatePlanGraph(plan: Pick<Plan, 'steps'>): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) problems.push(`Step ${step.id} is listed twice.`);
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dep of step.after) {
      if (!ids.has(dep))
        problems.push(`Step ${step.id} waits on ${dep}, which is not in the plan.`);
      if (dep === step.id) problems.push(`Step ${step.id} waits on itself.`);
    }
  }
  problems.push(...stepLoops(plan.steps));
  return [...new Set(problems)];
}

/** Each loop in the `after` graph, as one sentence. A step waiting on itself is reported apart. */
function stepLoops(steps: PlanStep[]): string[] {
  const loops: string[] = [];
  const after = new Map(steps.map((s) => [s.id, s.after]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      loops.push(`Steps wait on each other in a loop: ${[...path, id].join(' -> ')}.`);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of after.get(id) ?? []) if (dep !== id) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const step of steps) visit(step.id, []);
  return loops;
}

export type StepChange =
  | 'role'
  | 'runtime'
  | 'model'
  | 'title'
  | 'after'
  | 'deliverables'
  | 'members';

/** One line of a plan change card. */
export type PlanDiffEntry =
  | { kind: 'added'; step: string }
  | { kind: 'removed'; step: string }
  | { kind: 'changed'; step: string; fields: StepChange[] }
  | { kind: 'moved'; step: string }
  | { kind: 'budget'; from: number; to: number }
  | { kind: 'playbook'; from: string; to: string }
  | { kind: 'summary' }
  | { kind: 'queue'; from: number | null; to: number | null };

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));

function stepChanges(a: PlanStep, b: PlanStep): StepChange[] {
  const fields: StepChange[] = [];
  if (a.role !== b.role) fields.push('role');
  if (a.runtime !== b.runtime) fields.push('runtime');
  if (a.model !== b.model) fields.push('model');
  if (a.title !== b.title) fields.push('title');
  if (!sameList(a.after, b.after)) fields.push('after');
  if (!sameList(a.deliverables, b.deliverables)) fields.push('deliverables');
  if (!sameList(a.changes, b.changes) || !sameList(a.reads, b.reads)) fields.push('members');
  return fields;
}

/** What `next` changes against `prev` (null: nothing approved yet, so no diff). */
export function diffPlans(prev: Plan | null, next: Plan): PlanDiffEntry[] {
  if (prev === null) return [];
  const before = new Map(prev.steps.map((s) => [s.id, s]));
  const after = new Map(next.steps.map((s) => [s.id, s]));
  const diff: PlanDiffEntry[] = [];
  if (prev.playbook !== next.playbook) {
    diff.push({ kind: 'playbook', from: prev.playbook, to: next.playbook });
  }
  if (prev.summary !== next.summary) diff.push({ kind: 'summary' });
  for (const step of prev.steps) {
    if (!after.has(step.id)) diff.push({ kind: 'removed', step: step.id });
  }
  const kept = prev.steps.filter((s) => after.has(s.id)).map((s) => s.id);
  const keptNext = next.steps.filter((s) => before.has(s.id)).map((s) => s.id);
  for (const step of next.steps) {
    const old = before.get(step.id);
    if (!old) {
      diff.push({ kind: 'added', step: step.id });
      continue;
    }
    const fields = stepChanges(old, step);
    if (fields.length > 0) diff.push({ kind: 'changed', step: step.id, fields });
    if (kept.indexOf(step.id) !== keptNext.indexOf(step.id)) {
      diff.push({ kind: 'moved', step: step.id });
    }
  }
  if (prev.budget.usd !== next.budget.usd) {
    diff.push({ kind: 'budget', from: prev.budget.usd, to: next.budget.usd });
  }
  if (prev.queueBehind !== next.queueBehind) {
    diff.push({ kind: 'queue', from: prev.queueBehind, to: next.queueBehind });
  }
  return diff;
}

/** A diff entry as one line for the card and the model. */
export function diffLine(entry: PlanDiffEntry): string {
  switch (entry.kind) {
    case 'added':
      return `Adds ${entry.step}`;
    case 'removed':
      return `Removes ${entry.step}`;
    case 'changed':
      return `Changes ${entry.step}: ${entry.fields.join(', ')}`;
    case 'moved':
      return `Moves ${entry.step}`;
    case 'budget':
      return `Budget $${entry.from} to $${entry.to}`;
    case 'playbook':
      return `Playbook ${entry.from} to ${entry.to}`;
    case 'summary':
      return 'New summary';
    case 'queue':
      return entry.to === null ? 'Runs next to other jobs' : `Waits for j${entry.to}`;
  }
}
