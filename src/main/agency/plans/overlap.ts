import type { PlanOverlap } from '../../../shared/agency-jobs';
import type { Plan } from '../../../shared/agency-plan';

/** The paths each live step of another running job expects to touch. */
export type OtherJobPaths = {
  jobId: number;
  steps: Array<{ step: string; paths: string[] }>;
};

type MemberPath = { member: string; path: string };

/** `src/app/`, `src/app/*` and `src/app/**` all mean the folder `src/app`. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, '')
    .replace(/(\/\*\*?)+$/, '')
    .replace(/\/+$/, '');
}

/** A path names a member when it starts with `<member>/`; any other path is in the first member. */
export function splitMember(path: string, members: readonly string[]): MemberPath {
  const clean = normalizePath(path);
  const member = members.find((m) => clean === m || clean.startsWith(`${m}/`));
  if (member === undefined) return { member: members[0] ?? '', path: clean };
  return { member, path: normalizePath(clean.slice(member.length + 1)) };
}

/** The same path, or one is a folder the other is in. An empty path is the whole member. */
function overlaps(a: string, b: string): boolean {
  return a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The narrower of each pair of paths that overlap in the same member. */
function overlapping(mine: MemberPath[], theirs: MemberPath[]): MemberPath[] {
  return mine.flatMap((a) =>
    theirs
      .filter((b) => a.member === b.member && overlaps(a.path, b.path))
      .map((b) => (a.path.length >= b.path.length ? a : b))
  );
}

/**
 * Paths a plan and other running jobs in the same project both expect to
 * touch, per member: one row per step of this plan and other job, with the
 * narrower of the two paths.
 */
export function planOverlap(
  plan: Pick<Plan, 'steps'>,
  members: readonly string[],
  others: readonly OtherJobPaths[]
): PlanOverlap[] {
  const split = (paths: string[]): MemberPath[] => paths.map((p) => splitMember(p, members));
  const rows = plan.steps.flatMap((step) =>
    others.flatMap((other) =>
      overlapping(split(step.paths), split(other.steps.flatMap((s) => s.paths))).map(
        (m): PlanOverlap => ({ jobId: other.jobId, member: m.member, path: m.path, step: step.id })
      )
    )
  );
  return [...new Map(rows.map((r) => [JSON.stringify(r), r])).values()];
}
