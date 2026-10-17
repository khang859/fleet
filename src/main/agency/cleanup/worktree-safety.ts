import type { GitRun } from '../repo-identity';

/** What is in a worktree that removing it would lose. `unmerged` is null when git could not tell. */
export type WorktreeState = { dirty: number; untracked: number; unmerged: number | null };

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Whether cleanup may remove a worktree. Never one with uncommitted changes,
 * untracked files, or commits that are on no other branch and no remote;
 * when git could not say, it keeps it.
 */
export function removalVerdict(
  state: WorktreeState
): { remove: true } | { remove: false; reason: string } {
  const found = [
    state.dirty > 0 ? plural(state.dirty, 'uncommitted change') : null,
    state.untracked > 0 ? plural(state.untracked, 'untracked file') : null,
    state.unmerged === null ? 'git could not tell if its commits are safe' : null,
    state.unmerged !== null && state.unmerged > 0
      ? `${plural(state.unmerged, 'commit')} on no other branch or remote`
      : null
  ].filter((s): s is string => s !== null);
  return found.length === 0 ? { remove: true } : { remove: false, reason: found.join(', ') };
}

/**
 * Read a worktree's state with read-only git. Commits count as safe when any
 * other branch or a remote holds them, so a pushed PR branch can go: the
 * remote keeps its commits. `branch` is the worktree's own branch, which
 * cleanup deletes, so it does not count.
 */
export async function inspectWorktree(
  path: string,
  branch: string | null,
  git: GitRun,
  opts: { ignoreSubmodules?: boolean } = {}
): Promise<WorktreeState> {
  const status = await git(
    [
      '--no-optional-locks',
      'status',
      '--porcelain',
      ...(opts.ignoreSubmodules === true ? ['--ignore-submodules=all'] : [])
    ],
    path
  );
  const own = branch === null ? [] : [`--exclude=${branch}`];
  const count = await git(
    ['rev-list', '--count', 'HEAD', '--not', ...own, '--branches', '--remotes'],
    path
  );
  if (status === null) return { dirty: 0, untracked: 0, unmerged: null };
  const lines = status.split('\n').filter((l) => l !== '');
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const unmerged = count === null || !/^\d+$/.test(count) ? null : Number(count);
  return { dirty: lines.length - untracked, untracked, unmerged };
}
