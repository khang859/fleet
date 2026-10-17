import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { jobDisplayId } from '../../../shared/agency';
import { gitExec } from '../exec';
import type { AgencyStore } from '../store/agency-store';
import type { GitWrite } from './job-workspace';

/** A changed submodule and the commit its PR merged as. */
export type BumpedMember = { name: string; path: string; sha: string };

export type BumpInput = {
  jobId: number;
  umbrella: { name: string; root: string };
  /** The umbrella's default branch, which the bump starts from and targets. */
  base: string;
  members: BumpedMember[];
};

export const bumpBranch = (jobId: number): string => `admiral/${jobDisplayId(jobId)}/bump`;

/**
 * Commit and push the umbrella pointer bump: a worktree of the umbrella at its
 * fetched default branch, on `admiral/<job>/bump`, with each changed
 * submodule moved to its merged commit, pushed to `origin`. Only the gitlinks
 * change; no submodule is checked out. The worktree is recorded first, so the
 * job's cleanup removes it. Returns the worktree, for `gh pr create` to run in.
 */
export async function pushUmbrellaBump(
  input: BumpInput,
  deps: { store: AgencyStore; home: () => string; git?: GitWrite }
): Promise<{ path: string; branch: string }> {
  const git = deps.git ?? gitExec;
  const branch = bumpBranch(input.jobId);
  const path = join(deps.home(), 'jobs', String(input.jobId), 'ws', 'bump');
  const run = async (args: string[], cwd: string, what: string): Promise<void> => {
    if ((await git(args, cwd)) === null) throw new Error(`Could not ${what}.`);
  };
  await run(
    ['fetch', '--quiet', 'origin', input.base],
    input.umbrella.root,
    `fetch ${input.base} of ${input.umbrella.name}`
  );
  // A bump that failed after its worktree was made picks up where it stopped.
  if (!existsSync(path)) {
    const resource = deps.store.resources.record({
      jobId: input.jobId,
      kind: 'umbrella_worktree',
      label: `${input.umbrella.name} bump worktree`,
      member: input.umbrella.name,
      path,
      branch
    });
    await run(
      ['worktree', 'add', '--quiet', '-B', branch, path, `origin/${input.base}`],
      input.umbrella.root,
      `add the bump worktree of ${input.umbrella.name}`
    );
    deps.store.resources.made(resource.id);
  }
  for (const m of input.members) {
    await run(
      ['update-index', '--cacheinfo', `160000,${m.sha},${m.path}`],
      path,
      `move ${m.path} to ${m.sha.slice(0, 7)}`
    );
  }
  const names = input.members.map((m) => m.name).join(', ');
  // Nothing staged: an earlier try committed it already.
  if ((await git(['diff', '--cached', '--quiet'], path)) === null) {
    await run(
      ['commit', '--quiet', '-m', `chore: move ${names} to their merged commits`],
      path,
      `commit the bump of ${names}`
    );
  }
  await run(['push', '--quiet', '-u', 'origin', `${branch}:${branch}`], path, `push ${branch}`);
  return { path, branch };
}
