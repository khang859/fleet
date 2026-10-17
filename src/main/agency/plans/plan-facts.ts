import type { PlanBases } from '../../../shared/agency-jobs';
import { githubSlug } from '../../../shared/agency-projects';
import type { Plan } from '../../../shared/agency-plan';
import { ghState, type GhRun } from '../projects/gh';
import type { ProjectMember } from '../projects/workspace-projects';
import { repoFacts } from '../projects/repo-reader';
import type { GitRun } from '../repo-identity';
import { planOverlap, type OtherJobPaths } from './overlap';
import type { MemberFacts, PlanFacts } from './plan-checks';

export type PlanFactsDeps = { git: GitRun; gh: GhRun };

async function sha(git: GitRun, root: string, ref: string): Promise<string | null> {
  const out = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
  return out === null || out.trim() === '' ? null : out.trim();
}

/**
 * The default branch tip as the remote last showed it, else the local branch.
 * Nothing is fetched: the check reads what is on disk.
 */
async function defaultTip(
  git: GitRun,
  root: string,
  branch: string | null
): Promise<string | null> {
  if (branch === null) return null;
  return (
    (await sha(git, root, `refs/remotes/origin/${branch}`)) ??
    (await sha(git, root, `refs/heads/${branch}`))
  );
}

/** Read one member's checkout with read-only git. */
export async function memberFacts(
  { name, path, root }: ProjectMember,
  git: GitRun
): Promise<MemberFacts> {
  const { defaultBranch, remote } = await repoFacts(root, git);
  const status = await git(['--no-optional-locks', 'status', '--porcelain'], root);
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  return {
    name,
    atRoot: path === '.',
    githubSlug: githubSlug(remote),
    dirty: status === null ? 0 : status.split('\n').filter((l) => l.trim() !== '').length,
    hasAdmiralBranch:
      (await git(['show-ref', '--verify', '--quiet', 'refs/heads/admiral'], root)) !== null,
    defaultBranch,
    defaultSha: await defaultTip(git, root, defaultBranch),
    headBranch: head === null || head.trim() === '' ? null : head.trim(),
    headSha: await sha(git, root, 'HEAD')
  };
}

/**
 * Everything the pre-approval check needs, read just before it runs: each
 * member's checkout, the GitHub CLI when a step delivers a PR, and the paths
 * other running jobs touch. `members` are the project's, in member order.
 */
export async function gatherPlanFacts(
  input: {
    members: ProjectMember[];
    plan: Plan;
    others: OtherJobPaths[];
    pinned: PlanBases | null;
    roles: ReadonlySet<string> | null;
  },
  deps: PlanFactsDeps
): Promise<PlanFacts> {
  const members = await Promise.all(input.members.map(async (m) => memberFacts(m, deps.git)));
  const wantsPr = input.plan.steps.some((s) => s.deliverables.some((d) => d.kind === 'pr'));
  return {
    gh: wantsPr ? await ghState(deps.gh, input.members[0].root) : 'ok',
    members,
    overlap: planOverlap(
      input.plan,
      members.map((m) => m.name),
      input.others
    ),
    pinned: input.pinned,
    roles: input.roles
  };
}
