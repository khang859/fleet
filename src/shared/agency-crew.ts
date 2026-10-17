import { z } from 'zod';
import { PLAN_MAX_STEPS, StepIdSchema, validatePlanGraph } from './agency-plan';

/**
 * Crew roles and playbooks: Markdown files with a frontmatter block, in
 * `crew/roles/*.md` and `crew/playbooks/*.md`. A role says who a crew member
 * is and what it runs on; its body is the prompt the member gets. A playbook
 * is a step list the Admiral starts a plan from.
 *
 * They come from three places, most specific last: the ones Fleet ships, the
 * user's `~/.fleet/crew/`, and the project folder's `crew/`. A name found
 * twice resolves to the most specific.
 */

export const CREW_RUNTIMES = ['claude', 'eva'] as const;
export type CrewRuntime = (typeof CREW_RUNTIMES)[number];

/** Where a crew file was found. Decides precedence, and is shown in Settings. */
export type CrewSource = 'project' | 'user' | 'bundled';

const Name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a name is lower-case letters, digits and dashes');
const Description = z.string().trim().min(1).max(400);

/** Strict, so a misspelt key is an error in Settings rather than a setting that does nothing. */
export const RoleFrontmatter = z.strictObject({
  name: Name,
  description: Description,
  runtime: z.enum(CREW_RUNTIMES).default('claude'),
  /** A model the runtime knows, such as `sonnet` for Claude Code. Unset: the runtime's default. */
  model: z.string().trim().min(1).max(120).optional(),
  /** Its steps need the project's running stack, so they wait for a stack slot. */
  stack: z.boolean().default(false)
});

/**
 * Where a step works: `new` is a fresh worktree, `{of}` reads another step's
 * worktree, `{integrate}` is a fresh worktree that merges those steps' branches.
 */
export const WorkspaceSpecSchema = z.union([
  z.literal('new'),
  z.strictObject({ of: StepIdSchema }),
  z.strictObject({ integrate: z.array(StepIdSchema).min(1).max(PLAN_MAX_STEPS) })
]);
export type WorkspaceSpec = z.output<typeof WorkspaceSpecSchema>;

export const PLAYBOOK_MAX_COUNT = 6;

export const PlaybookStepSchema = z.strictObject({
  id: StepIdSchema,
  role: Name,
  /** How many members of the role work the step side by side, each in its own scope. */
  count: z.number().int().min(1).max(PLAYBOOK_MAX_COUNT).default(1),
  after: z.array(StepIdSchema).max(PLAN_MAX_STEPS).default([]),
  /** `client`: the client looks at the step's output before the steps after it start. */
  gate: z.literal('client').optional(),
  workspace: WorkspaceSpecSchema.default('new'),
  /** One per member when `count` > 1: the part of the code each one owns. */
  scopes: z.array(z.string().trim().min(1).max(80)).max(PLAYBOOK_MAX_COUNT).default([])
});
export type PlaybookStep = z.output<typeof PlaybookStepSchema>;

export const PlaybookFrontmatter = z.strictObject({
  name: Name,
  description: Description,
  steps: z.array(PlaybookStepSchema).min(1).max(PLAN_MAX_STEPS)
});

type FileFields = { source: CrewSource; path: string };

export type CrewRole = z.output<typeof RoleFrontmatter> & FileFields & { prompt: string };
export type CrewPlaybook = z.output<typeof PlaybookFrontmatter> & FileFields & { notes: string };

/** A crew file that did not load, and why, for Settings to show. */
export type CrewFileError = FileFields & { why: string };

export type CrewCatalog = {
  roles: CrewRole[];
  playbooks: CrewPlaybook[];
  errors: CrewFileError[];
};

export const EMPTY_CREW: CrewCatalog = { roles: [], playbooks: [], errors: [] };

/** Each step as the wait graph sees it: `after`, plus the steps its workspace reads or merges. */
function waits(step: PlaybookStep): string[] {
  const ws = step.workspace;
  if (ws === 'new') return step.after;
  return [...step.after, ...('of' in ws ? [ws.of] : ws.integrate)];
}

/** Every step `id` waits on, directly or through others. */
function upstream(id: string, after: Map<string, string[]>): Set<string> {
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

/** A step that works in another step's output has to wait for that step. */
function workspaceProblems(step: PlaybookStep, after: Map<string, string[]>): string[] {
  const ws = step.workspace;
  const reads = ws === 'new' ? [] : 'of' in ws ? [ws.of] : ws.integrate;
  const done = upstream(step.id, after);
  return reads
    .filter((id) => after.has(id) && !done.has(id))
    .map((id) => `Step ${step.id} works in ${id}'s output, so it has to wait for ${id}.`);
}

/** Side-by-side members need one scope each, and a later step that merges their branches. */
function countProblems(step: PlaybookStep, steps: PlaybookStep[]): string[] {
  if (step.count === 1) {
    return step.scopes.length > 0 ? [`Step ${step.id} has one member, so it takes no scopes.`] : [];
  }
  const problems: string[] = [];
  if (new Set(step.scopes).size !== step.count) {
    problems.push(
      `Step ${step.id} has ${step.count} members, so it needs ${step.count} different scopes.`
    );
  }
  const merged = steps.some(
    (s) =>
      s.workspace !== 'new' && 'integrate' in s.workspace && s.workspace.integrate.includes(step.id)
  );
  if (!merged)
    problems.push(
      `Step ${step.id} has ${step.count} members, so a later step has to integrate it.`
    );
  return problems;
}

/**
 * What is wrong with a playbook beyond its frontmatter, one sentence each:
 * the wait graph, roles that do not exist, workspaces of steps that have not
 * finished first, and side-by-side steps with no scopes or no integrate step.
 * Empty when it is fine.
 */
export function checkPlaybook(
  playbook: { steps: PlaybookStep[] },
  roles: ReadonlySet<string>
): string[] {
  const { steps } = playbook;
  const after = new Map(steps.map((s) => [s.id, s.after]));
  const problems = [
    ...validatePlanGraph({ steps: steps.map((s) => ({ id: s.id, after: waits(s) })) }),
    ...steps.flatMap((step) => [
      ...(roles.has(step.role)
        ? []
        : [`Step ${step.id} uses role ${step.role}, which is not a role.`]),
      ...workspaceProblems(step, after),
      ...countProblems(step, steps)
    ])
  ];
  return [...new Set(problems)];
}

const RoleRecord = RoleFrontmatter.extend({
  source: z.enum(['project', 'user', 'bundled']),
  path: z.string(),
  prompt: z.string(),
  sha256: z.string()
});
const PlaybookRecord = PlaybookFrontmatter.extend({
  source: z.enum(['project', 'user', 'bundled']),
  path: z.string(),
  notes: z.string(),
  sha256: z.string()
});

/**
 * The roles and playbook an approved plan uses, as their files said at
 * approval. The job runs on this, so editing a role never reaches a job
 * already running.
 */
export const CrewSnapshotSchema = z.object({
  roles: z.array(RoleRecord),
  playbook: PlaybookRecord.nullable()
});
export type CrewSnapshot = z.output<typeof CrewSnapshotSchema>;

/**
 * The oldest versions crew can run on: every flag and settings key Fleet
 * passes is there from these on. See docs/learnings/claude-code-crew-flags.md.
 */
export const RUNTIME_MIN_VERSION: Record<CrewRuntime, string> = {
  claude: '2.1.78',
  eva: '0.3.0'
};

export const RUNTIME_LABEL: Record<CrewRuntime, string> = { claude: 'Claude Code', eva: 'eva' };

/**
 * Whether crew can run on a runtime, as a pane in the project would start it.
 * `problems` keep Approve off for a plan that needs it; `warnings` do not.
 */
export type RuntimeCheck = {
  runtime: CrewRuntime;
  path: string | null;
  version: string | null;
  problems: string[];
  warnings: string[];
};
