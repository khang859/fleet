import { jobDisplayId } from '../../../shared/agency';
import type {
  MemberBase,
  PlanBases,
  PlanChecks,
  PlanIssue,
  PlanOverlap
} from '../../../shared/agency-jobs';
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
};

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
export function checkPlan(plan: Plan, facts: PlanFacts): PlanChecks {
  const names = new Set(facts.members.map((m) => m.name));
  const used = new Set(plan.steps.flatMap((s) => [...changedMembers(s, [...names]), ...s.reads]));
  const members = facts.members.filter((m) => m.atRoot || used.has(m.name));
  return {
    issues: [
      ...outsideProject(plan, names),
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
    )
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
