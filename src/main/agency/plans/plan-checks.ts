import { jobDisplayId } from '../../../shared/agency';
import type {
  MemberBase,
  PlanBases,
  PlanChecks,
  PlanIssue,
  PlanOverlap,
  StepEnvFiles
} from '../../../shared/agency-jobs';
import { RUNTIME_LABEL, type CrewRuntime, type RuntimeCheck } from '../../../shared/agency-crew';
import type { Plan, PlanStep } from '../../../shared/agency-plan';

/** What Fleet read about one member repository just before the check. */
export type MemberFacts = {
  name: string;
  /**
   * The project root: the umbrella, or the one repository. Every job
   * workspace is made from it, so its base is pinned whatever the steps name.
   */
  atRoot: boolean;
  /** `owner/name` of its GitHub remote, or null when it has none. */
  githubSlug: string | null;
  /** Uncommitted and untracked paths in its main checkout. */
  dirty: number;
  /** A branch named exactly `admiral`, which blocks every `admiral/...` crew branch. */
  hasAdmiralBranch: boolean;
  defaultBranch: string | null;
  defaultSha: string | null;
  headBranch: string | null;
  headSha: string | null;
};

export type PlanFacts = {
  gh: 'ok' | 'not-installed' | 'signed-out';
  members: MemberFacts[];
  overlap: PlanOverlap[];
  /** Bases an earlier approval pinned; a change keeps them. */
  pinned: PlanBases | null;
  /** The project's crew, or null when it is not known. */
  crew: CrewFacts | null;
  /** The env files the client gave crew, each with its member and its path from the project root. */
  envFiles: Array<{ member: string; file: string }>;
};

export type CrewFacts = {
  /** Each crew role's runtime, by role name. */
  roles: ReadonlyMap<string, CrewRuntime>;
  /** What the check found for each runtime a step runs on. */
  runtimes: Partial<Record<CrewRuntime, RuntimeCheck>>;
  /**
   * The folder whose Claude Code folder trust covers the crew's working
   * folders, and whether a Claude Code session has reported from it, which
   * it only does once the trust prompt is accepted.
   */
  claudeTrust: { folder: string; trusted: boolean };
};

/** What a step runs on: its own runtime, else its role's; null for a role that is not there. */
export function stepRuntime(
  step: PlanStep,
  roles: ReadonlyMap<string, CrewRuntime>
): CrewRuntime | null {
  return step.runtime ?? roles.get(step.role) ?? null;
}

/** The members a step changes: those it names, or every member when it names none. */
export function changedMembers(step: PlanStep, members: readonly string[]): string[] {
  return step.changes.length === 0 ? [...members] : step.changes;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function outsideProject(plan: Plan, names: Set<string>): PlanIssue[] {
  return plan.steps.flatMap((step) =>
    [...step.changes, ...step.reads]
      .filter((m) => !names.has(m))
      .map(
        (member): PlanIssue => ({
          code: 'member-outside-project',
          severity: 'block',
          text: `${step.id} names ${member}, which is not in this project.`,
          step: step.id,
          member
        })
      )
  );
}

const GH_PROBLEM: Record<PlanFacts['gh'], string | null> = {
  ok: null,
  'not-installed': 'the GitHub CLI is not installed',
  'signed-out': 'the GitHub CLI is not signed in'
};

/** Why a step cannot open a PR: a member it changes has no GitHub remote, or `gh` cannot. */
function prBlocker(step: PlanStep, facts: PlanFacts): string | null {
  const names = facts.members.map((m) => m.name);
  const changed = new Set(changedMembers(step, names));
  const local = facts.members.filter((m) => changed.has(m.name) && m.githubSlug === null);
  if (local.length > 0) {
    return `${local.map((m) => m.name).join(' and ')} ${local.length === 1 ? 'has' : 'have'} no GitHub remote`;
  }
  return GH_PROBLEM[facts.gh];
}

/** A `pr` needs a GitHub remote on every member the step changes, and a signed-in `gh`. */
function prUnavailable(plan: Plan, facts: PlanFacts): PlanIssue[] {
  return plan.steps.flatMap((step): PlanIssue[] => {
    if (!step.deliverables.some((d) => d.kind === 'pr')) return [];
    const why = prBlocker(step, facts);
    if (why === null) return [];
    return [
      {
        code: 'pr-unavailable',
        severity: 'block',
        text: `${step.id} delivers a PR, but ${why}. Deliver a local branch instead.`,
        step: step.id,
        fix: 'use-branch'
      }
    ];
  });
}

/** A step whose role is not one of the project's crew roles. */
function unknownRoles(plan: Plan, roles: ReadonlyMap<string, CrewRuntime>): PlanIssue[] {
  return plan.steps
    .filter((step) => !roles.has(step.role))
    .map(
      (step): PlanIssue => ({
        code: 'unknown-role',
        severity: 'block',
        text: `${step.id} uses the role ${step.role}, which is not one of this project's crew roles.`,
        step: step.id
      })
    );
}

/** Steps on a runtime crew cannot use, one issue per runtime. */
function runtimeIssues(plan: Plan, crew: CrewFacts): PlanIssue[] {
  return Object.values(crew.runtimes).flatMap((check): PlanIssue[] => {
    if (check.problems.length === 0) return [];
    const steps = plan.steps.filter((s) => stepRuntime(s, crew.roles) === check.runtime);
    return [
      {
        code: 'runtime-unavailable',
        severity: 'block',
        text: `${steps.map((s) => s.id).join(', ')} ${steps.length === 1 ? 'runs' : 'run'} on ${RUNTIME_LABEL[check.runtime]}. ${check.problems.join(' ')}`
      }
    ];
  });
}

/**
 * Claude Code asks once per folder whether to trust it, and no hook runs
 * until someone answers, so a crew member would wait at that prompt unseen.
 */
function trustIssue(plan: Plan, crew: CrewFacts): PlanIssue[] {
  const { folder, trusted } = crew.claudeTrust;
  if (trusted || !plan.steps.some((s) => stepRuntime(s, crew.roles) === 'claude')) return [];
  return [
    {
      code: 'claude-trust',
      severity: 'warn',
      text: `Claude Code has not run in ${folder} yet. Open it there once and trust the folder, or each Claude crew member waits for you at that prompt.`,
      fix: 'trust-claude',
      path: folder
    }
  ];
}

function crewIssues(plan: Plan, crew: CrewFacts | null): PlanIssue[] {
  if (crew === null) return [];
  return [
    ...unknownRoles(plan, crew.roles),
    ...runtimeIssues(plan, crew),
    ...trustIssue(plan, crew)
  ];
}

function memberIssues(member: MemberFacts): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (member.hasAdmiralBranch) {
    issues.push({
      code: 'admiral-branch-exists',
      severity: 'block',
      text: `${member.name} has a branch named admiral. Rename it first: crew branches are admiral/<job>/<step>, and git cannot have both.`,
      member: member.name
    });
  }
  if (member.dirty > 0) {
    issues.push({
      code: 'dirty-main',
      severity: 'warn',
      text: `${member.name} has ${plural(member.dirty, 'uncommitted change')} in its main checkout. They are not in the base, so crew do not see them.`,
      member: member.name
    });
  }
  return issues;
}

function overlapIssue(overlap: PlanOverlap[]): PlanIssue[] {
  if (overlap.length === 0) return [];
  const jobs = [...new Set(overlap.map((o) => jobDisplayId(o.jobId)))];
  return [
    {
      code: 'overlap',
      severity: 'warn',
      text: `${jobs.join(' and ')} ${jobs.length === 1 ? 'is' : 'are'} also working on ${plural(new Set(overlap.map((o) => `${o.member}/${o.path}`)).size, 'path')} this plan touches. Ask the client: queue this job behind, or run both?`
    }
  ];
}

/**
 * The pre-approval check: what would keep the plan from being met, and what
 * the client should know before approving. Pure over facts read just before,
 * so the same plan and facts always give the same card.
 */
/** The env files each step's workspace gets: those of the members it holds, the root always. */
function stepEnvFiles(plan: Plan, facts: PlanFacts): StepEnvFiles[] {
  const names = facts.members.map((m) => m.name);
  const root = facts.members.filter((m) => m.atRoot).map((m) => m.name);
  return plan.steps.flatMap((step) => {
    const held = new Set([...root, ...changedMembers(step, names), ...step.reads]);
    const files = facts.envFiles.filter((f) => held.has(f.member)).map((f) => f.file);
    return files.length === 0 ? [] : [{ stepId: step.id, files }];
  });
}

export function checkPlan(plan: Plan, facts: PlanFacts): PlanChecks {
  const names = new Set(facts.members.map((m) => m.name));
  const used = new Set(plan.steps.flatMap((s) => [...changedMembers(s, [...names]), ...s.reads]));
  const members = facts.members.filter((m) => m.atRoot || used.has(m.name));
  return {
    issues: [
      ...outsideProject(plan, names),
      ...crewIssues(plan, facts.crew),
      ...members.flatMap(memberIssues),
      ...prUnavailable(plan, facts),
      ...overlapIssue(facts.overlap)
    ],
    overlap: facts.overlap,
    bases: members.map(
      (m): MemberBase => ({
        member: m.name,
        defaultBranch: m.defaultBranch,
        defaultSha: m.defaultSha,
        headBranch: m.headBranch,
        headSha: m.headSha,
        pinned: facts.pinned?.[m.name] ?? null
      })
    ),
    envFiles: stepEnvFiles(plan, facts)
  };
}

/**
 * The base commit each member starts from: a pin an earlier approval made is
 * kept; a new member takes its default branch tip, or its HEAD when the
 * client picked that. Refused when a member has no commit to start from.
 */
export function pinBases(
  bases: readonly MemberBase[],
  choice: Record<string, 'default' | 'head'>
): { ok: true; bases: PlanBases } | { ok: false; reason: string } {
  const pinned: PlanBases = {};
  for (const base of bases) {
    if (base.pinned !== null) {
      pinned[base.member] = base.pinned;
      continue;
    }
    // A member whose default branch has no commit yet starts from its HEAD.
    const head = choice[base.member] === 'head' || base.defaultSha === null;
    const sha = head ? base.headSha : base.defaultSha;
    if (sha === null) return { ok: false, reason: `${base.member} has no commit to start from.` };
    pinned[base.member] = { sha, from: head ? 'head' : 'default' };
  }
  return { ok: true, bases: pinned };
}
