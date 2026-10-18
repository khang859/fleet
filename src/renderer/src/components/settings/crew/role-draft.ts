import {
  RoleDraftSchema,
  RUNTIME_LABEL,
  type CrewModel,
  type CrewPlaybook,
  type CrewRuntime,
  type CrewSource,
  type RoleDraft
} from '../../../../../shared/agency-crew';

/** The key a new role's draft is kept under, which no role name can be. */
export const NEW_ROLE = '+new';

export const EMPTY_ROLE: RoleDraft = {
  name: '',
  description: '',
  runtime: 'claude',
  stack: false,
  instructions: ''
};

export const SOURCE_LABEL: Record<CrewSource, string> = {
  project: 'This project',
  user: 'All projects',
  bundled: 'Fleet'
};

export function sameDraft(a: RoleDraft, b: RoleDraft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.runtime === b.runtime &&
    (a.model ?? '') === (b.model ?? '') &&
    a.stack === b.stack &&
    a.instructions.trim() === b.instructions.trim()
  );
}

/**
 * Move a draft to another runtime. A model names a model of one runtime
 * only, so it goes back to the runtime default, except on the way back to the
 * saved runtime, which gets the saved model again.
 */
export function switchRuntime(draft: RoleDraft, to: CrewRuntime, saved: RoleDraft): RoleDraft {
  if (to === draft.runtime) return draft;
  return { ...draft, runtime: to, model: to === saved.runtime ? saved.model : undefined };
}

/** What a runtime switch changed, or null when the draft keeps the saved runtime. */
export function switchNote(draft: RoleDraft, saved: RoleDraft): string | null {
  if (draft.runtime === saved.runtime) return null;
  const from = RUNTIME_LABEL[saved.runtime];
  return saved.model === undefined
    ? `Switched from ${from}. Model stays Runtime default.`
    : `Switched from ${from}. ${saved.model} only works on ${from}, so Model is now Runtime default.`;
}

/** Why a draft cannot be saved, or null. */
export function draftProblem(draft: RoleDraft): string | null {
  const parsed = RoleDraftSchema.safeParse(draft);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const key = String(issue.path[0]);
  if (key === 'name') {
    return draft.name === ''
      ? 'Name is empty.'
      : 'Name is lower-case letters, digits and dashes, like data-migrator.';
  }
  const field = { description: 'When to hire', instructions: 'Instructions' }[key];
  if (field === undefined) return issue.message;
  if (issue.code === 'too_small') return `${field} is empty.`;
  return issue.code === 'too_big' ? `${field} is too long.` : `${field}: ${issue.message}.`;
}

/** A model the server no longer lists, for an eva role; never for Claude Code, which takes any id. */
export function modelMissing(draft: RoleDraft, models: CrewModel[] | null): boolean {
  return (
    draft.runtime === 'eva' &&
    draft.model !== undefined &&
    models !== null &&
    !models.some((m) => m.id === draft.model)
  );
}

/** How many roles run on `model` of `runtime`, as the drafts have them. */
export function rolesUsing(
  drafts: readonly RoleDraft[],
  runtime: CrewRuntime,
  model: string | undefined
): number {
  return drafts.filter((d) => d.runtime === runtime && d.model === model).length;
}

/** `data-migrator` as `Data migrator`, `qa` as `QA`, and `e2e-tester` as `E2E tester`. */
export function roleTitle(name: string): string {
  // A word of one or two letters, or one with a digit, is an acronym, as in
  // `qa`, `ui-designer` or `e2e-tester`.
  const words = name.split('-').map((w) => (w.length <= 2 || /\d/.test(w) ? w.toUpperCase() : w));
  const line = words.join(' ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * A playbook's steps as one line: `Architect → you → Builder ×2 → Reviewer`.
 * Steps that wait for the same steps run side by side, joined with `+`, and
 * a client gate is "you".
 */
export function playbookLine(playbook: CrewPlaybook): string {
  const parts: string[] = [];
  let prevAfter: string | null = null;
  let gate = false;
  for (const step of playbook.steps) {
    const name = `${roleTitle(step.role)}${step.count > 1 ? ` ×${step.count}` : ''}`;
    const after = [...step.after].sort().join(',');
    if (after === prevAfter && !gate && parts.length > 0) parts[parts.length - 1] += ` + ${name}`;
    else parts.push(name);
    gate = step.gate === 'client';
    if (gate) parts.push('you');
    prevAfter = after;
  }
  return parts.join(' → ');
}
