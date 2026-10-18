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

export const StepIdSchema = z
  .string()
  .regex(STEP_ID_PATTERN, 'a step id is lower-case letters, digits and dashes, like builder-1');
const Member = z.string().trim().min(1).max(200);
const Names = z.array(Member).max(50);

/**
 * Where a step works: `new` is a fresh worktree from the base with the
 * branches of its `after` steps merged in, `{of}` reads another step's
 * worktree, `{integrate}` is a fresh worktree that merges those steps' branches.
 */
export const WorkspaceSpecSchema = z.union([
  z.literal('new'),
  z.strictObject({ of: StepIdSchema }),
  z.strictObject({ integrate: z.array(StepIdSchema).min(1).max(PLAN_MAX_STEPS) })
]);
export type WorkspaceSpec = z.output<typeof WorkspaceSpecSchema>;

/** The steps whose output a workspace reads or merges. */
export function workspaceSources(ws: WorkspaceSpec): string[] {
  return ws === 'new' ? [] : 'of' in ws ? [ws.of] : ws.integrate;
}

/** A skill's name, as its folder has it; Claude Code shows a nested one as `<dir>:<name>`. */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** The most a crew member of a capped step may work. */
export const STEP_CAP_MAX_TURNS = 200;
export const STEP_CAP_MAX_MINUTES = 24 * 60;

/**
 * The most turns or minutes each crew member of a step may work before Fleet
 * stops it, for a step whose cost Fleet cannot measure. Hiring again after a
 * stop needs the client's OK, so each round is theirs to allow.
 */
export const StepCapSchema = z
  .object({
    turns: z.number().int().min(1).max(STEP_CAP_MAX_TURNS).optional(),
    minutes: z.number().int().min(1).max(STEP_CAP_MAX_MINUTES).optional()
  })
  .refine((cap) => cap.turns !== undefined || cap.minutes !== undefined, {
    message: 'A cap needs turns, minutes or both.'
  });
export type StepCap = z.infer<typeof StepCapSchema>;

/** `20 turns or 60 minutes`. */
export function capText(cap: StepCap): string {
  const parts = [
    cap.turns === undefined ? null : `${cap.turns} turn${cap.turns === 1 ? '' : 's'}`,
    cap.minutes === undefined ? null : `${cap.minutes} minute${cap.minutes === 1 ? '' : 's'}`
  ];
  return parts.filter((p) => p !== null).join(' or ');
}

export const PlanStepSchema = z.object({
  /** Stable across versions: the same id is the same step. */
  id: StepIdSchema,
  role: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  runtime: z.enum(['claude', 'eva']).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  /** Steps that must be done before this one starts. */
  after: z.array(StepIdSchema).max(PLAN_MAX_STEPS).default([]),
  /** Member repositories the step changes, and those it only reads. Empty: every member. */
  changes: Names.default([]),
  reads: Names.default([]),
  /** Paths the step expects to touch, as `member/dir`, for the overlap check. */
  paths: z.array(z.string().trim().min(1).max(400)).max(100).default([]),
  deliverables: z.array(DeliverableSchema).max(10).default([]),
  workspace: WorkspaceSpecSchema.default('new'),
  /** The part of the code the step owns, when it changes a member side by side with another step. */
  scope: z.string().trim().min(1).max(80).optional(),
  /** Skills of the repository it works in that the crew member uses, by name. */
  skills: z.array(z.string().regex(SKILL_NAME_PATTERN)).max(10).default([]),
  cap: StepCapSchema.optional()
});

export const NEW_ROLE_MAX_CHARS = 8_000;
export const PLAN_MAX_NEW_ROLES = 5;
/** The most saved preference lines a plan may cite. */
export const PLAN_MAX_USES = 20;

/**
 * A role the plan brings because no crew role fits a step, written as the
 * fields of a role file. Fleet saves it in the project's crew folder, never
 * in the repository, only when the client approves the plan.
 */
export const NewRoleSchema = z.object({
  name: z
    .string()
    .regex(
      STEP_ID_PATTERN,
      'a role name is lower-case letters, digits and dashes, like data-migrator'
    ),
  description: z.string().trim().min(1).max(400),
  runtime: z.enum(['claude', 'eva']).default('claude'),
  model: z.string().trim().min(1).max(120).optional(),
  stack: z.boolean().default(false),
  /** The role file's body: the instructions every crew member of the role gets. */
  instructions: z.string().trim().min(1).max(NEW_ROLE_MAX_CHARS)
});
export type NewRole = z.output<typeof NewRoleSchema>;

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
  asksFirst: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  newRoles: z.array(NewRoleSchema).max(PLAN_MAX_NEW_ROLES).default([]),
  /** The client's saved preference lines the plan follows, by their id in the note: Y1, P2. */
  uses: z.array(z.string().trim().max(12)).max(PLAN_MAX_USES).default([])
});

export type PlanStep = z.output<typeof PlanStepSchema>;
export type Plan = z.output<typeof PlanSchema>;
export type PlanInput = z.input<typeof PlanSchema>;

/** A plan's steps on one line, each as its role, model when set, and title, to compare two versions. */
export const planStepList = (plan: Plan): string =>
  plan.steps
    .map((s) => `${s.role}${s.model === undefined ? '' : ` (${s.model})`}: ${s.title}`)
    .join('; ');

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

/** A step as the wait graph sees it: a plan's, or a playbook's. */
export type GraphStep = { id: string; after: string[]; workspace?: WorkspaceSpec };

/** Every step `id` waits on, directly or through others. */
export function upstream(id: string, after: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const walk = (at: string): void => {
    for (const dep of after.get(at) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return seen;
}

/**
 * A step works only in the committed output of steps it waits for, and reads
 * a worktree only of a step that made one, so each worktree has one writer.
 */
function workspaceProblems(steps: GraphStep[]): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const after = new Map(steps.map((s) => [s.id, s.after]));
  return steps.flatMap((step) => {
    const ws = step.workspace ?? 'new';
    const done = upstream(step.id, after);
    return workspaceSources(ws).flatMap((id) => {
      const source = byId.get(id);
      if (source === undefined)
        return [`Step ${step.id} works in ${id}'s output, which is not in the plan.`];
      if (!done.has(id))
        return [`Step ${step.id} works in ${id}'s output, so it has to wait for ${id}.`];
      if (
        ws !== 'new' &&
        'of' in ws &&
        source.workspace !== undefined &&
        source.workspace !== 'new' &&
        'of' in source.workspace
      ) {
        return [
          `Step ${step.id} reads ${id}'s worktree, but ${id} works in another step's. Read that one.`
        ];
      }
      return [];
    });
  });
}

/**
 * What is wrong with a plan's step graph, one sentence each: duplicate ids,
 * `after` naming a step that is not there, cycles, and workspaces of steps
 * that are not there or not waited for. Empty when it is fine.
 */
export function validatePlanGraph(plan: { steps: GraphStep[] }): string[] {
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
  problems.push(...stepLoops(plan.steps), ...workspaceProblems(plan.steps));
  return [...new Set(problems)];
}

/** A new role named twice, or one no step uses, one sentence each. */
export function newRoleProblems(plan: Plan): string[] {
  const used = new Set(plan.steps.map((s) => s.role));
  const seen = new Set<string>();
  return plan.newRoles.flatMap((role) => {
    if (seen.has(role.name)) return [`The new role ${role.name} is listed twice.`];
    seen.add(role.name);
    return used.has(role.name) ? [] : [`The new role ${role.name} is not used by any step.`];
  });
}

const OWN_BRANCH: ReadonlySet<DeliverableKind> = new Set(['pr', 'branch']);

/** Whether two members lists overlap; an empty list is every member. */
const shareMember = (a: string[], b: string[]): boolean =>
  a.length === 0 || b.length === 0 || a.some((m) => b.includes(m));

/**
 * Steps that hand back code side by side in the same member need a scope
 * each, so their branches merge cleanly. A step hands back code when it
 * delivers a branch or PR, or a later step merges its branch. A scoped step
 * nobody merges has to hand back its own branch, or its work goes nowhere.
 */
export function scopeProblems(steps: PlanStep[]): string[] {
  const merged = new Set(
    steps.flatMap((s) =>
      s.workspace === 'new' ? s.after : 'of' in s.workspace ? [] : s.workspace.integrate
    )
  );
  const ownBranch = (s: PlanStep): boolean => s.deliverables.some((d) => OWN_BRANCH.has(d.kind));
  const code = steps.filter(
    (s) => (s.workspace === 'new' || !('of' in s.workspace)) && (ownBranch(s) || merged.has(s.id))
  );
  const unmerged = steps.filter((s) => s.scope !== undefined && !ownBranch(s) && !merged.has(s.id));
  return [
    ...sideBySide(steps, code).map(
      ([a, b]) =>
        `Steps ${a.id} and ${b.id} change the same code side by side, so each needs its own scope.`
    ),
    ...unmerged.map(
      (s) =>
        `Step ${s.id} has a scope, so a later step has to merge its branch, or it hands back its own branch or PR.`
    )
  ];
}

/** The pairs of `code` steps that run side by side in a shared member without distinct scopes. */
function sideBySide(steps: PlanStep[], code: PlanStep[]): Array<[PlanStep, PlanStep]> {
  const after = new Map(steps.map((s) => [s.id, s.after]));
  const before = new Map(steps.map((s) => [s.id, upstream(s.id, after)]));
  const ordered = (a: PlanStep, b: PlanStep): boolean =>
    before.get(a.id)?.has(b.id) === true || before.get(b.id)?.has(a.id) === true;
  const scoped = (a: PlanStep, b: PlanStep): boolean =>
    a.scope !== undefined && b.scope !== undefined && a.scope !== b.scope;
  return code.flatMap((a, i) =>
    code
      .slice(i + 1)
      .filter((b) => !ordered(a, b) && shareMember(a.changes, b.changes) && !scoped(a, b))
      .map((b): [PlanStep, PlanStep] => [a, b])
  );
}

/** Each loop in the `after` graph, as one sentence. A step waiting on itself is reported apart. */
function stepLoops(steps: GraphStep[]): string[] {
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
  | 'members'
  | 'workspace'
  | 'skills'
  | 'cap';

/** One line of a plan change card. */
export type PlanDiffEntry =
  | { kind: 'added'; step: string }
  | { kind: 'removed'; step: string }
  | { kind: 'changed'; step: string; fields: StepChange[] }
  | { kind: 'moved'; step: string }
  | { kind: 'budget'; from: number; to: number }
  /** The share of the weekly Claude limit; null where the plan named none. */
  | { kind: 'week_share'; from: number | null; to: number | null }
  | { kind: 'playbook'; from: string; to: string }
  | { kind: 'summary' }
  | { kind: 'queue'; from: number | null; to: number | null }
  | { kind: 'role'; name: string };

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
  if (JSON.stringify(a.workspace) !== JSON.stringify(b.workspace) || a.scope !== b.scope) {
    fields.push('workspace');
  }
  if (!sameList(a.skills, b.skills)) fields.push('skills');
  if (JSON.stringify(a.cap) !== JSON.stringify(b.cap)) fields.push('cap');
  return fields;
}

/** The steps `next` adds, removes, changes or moves against `prev`. */
function stepDiff(prev: Plan, next: Plan): PlanDiffEntry[] {
  const before = new Map(prev.steps.map((s) => [s.id, s]));
  const after = new Set(next.steps.map((s) => s.id));
  const diff: PlanDiffEntry[] = prev.steps
    .filter((s) => !after.has(s.id))
    .map((s) => ({ kind: 'removed', step: s.id }));
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
  return diff;
}

/** What `next` changes against `prev` (null: nothing approved yet, so no diff). */
export function diffPlans(prev: Plan | null, next: Plan): PlanDiffEntry[] {
  if (prev === null) return [];
  const diff: PlanDiffEntry[] = [];
  if (prev.playbook !== next.playbook) {
    diff.push({ kind: 'playbook', from: prev.playbook, to: next.playbook });
  }
  if (prev.summary !== next.summary) diff.push({ kind: 'summary' });
  diff.push(...stepDiff(prev, next));
  if (prev.budget.usd !== next.budget.usd) {
    diff.push({ kind: 'budget', from: prev.budget.usd, to: next.budget.usd });
  }
  if (prev.budget.weekPct !== next.budget.weekPct) {
    diff.push({
      kind: 'week_share',
      from: prev.budget.weekPct ?? null,
      to: next.budget.weekPct ?? null
    });
  }
  if (prev.queueBehind !== next.queueBehind) {
    diff.push({ kind: 'queue', from: prev.queueBehind, to: next.queueBehind });
  }
  const roles = new Set(prev.newRoles.map((r) => r.name));
  for (const role of next.newRoles) {
    if (!roles.has(role.name)) diff.push({ kind: 'role', name: role.name });
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
    case 'week_share':
      return `Share of the weekly Claude limit ${entry.from === null ? 'none' : `${entry.from}%`} to ${entry.to === null ? 'none' : `${entry.to}%`}`;
    case 'playbook':
      return `Playbook ${entry.from} to ${entry.to}`;
    case 'summary':
      return 'New summary';
    case 'queue':
      return entry.to === null ? 'Runs next to other jobs' : `Waits for j${entry.to}`;
    case 'role':
      return `Adds the role ${entry.name}`;
  }
}
