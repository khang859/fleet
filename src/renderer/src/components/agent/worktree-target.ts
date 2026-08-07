import { stripTrailing } from './folder-crumbs';

/**
 * Where an agent should open inside a freshly created worktree, given the
 * folder the user actually picked.
 *
 * A worktree is always created from the repository root, but the user may well
 * have pointed at a folder inside it. Landing them at the worktree root would
 * silently move the agent somewhere they did not ask for, so the part of the
 * path below the root is carried across: picking `~/dev/fleet/src` opens the
 * agent at `<worktree>/src`.
 *
 * A target that is not under `repoRoot` has no counterpart to re-root onto, so
 * it falls back to the worktree itself rather than inventing a path.
 */
export function rerootIntoWorktree(target: string, repoRoot: string, worktreePath: string): string {
  const root = stripTrailing(repoRoot);
  const trimmedTarget = stripTrailing(target);
  const worktree = stripTrailing(worktreePath);

  if (trimmedTarget === root) return worktree;
  // `/repo` must not match `/repository` - only a separator ends the root.
  const rest = trimmedTarget.startsWith(root) ? trimmedTarget.slice(root.length) : '';
  if (!/^[\\/]/.test(rest)) return worktree;

  // Follow the worktree's own separator so a Windows path stays a Windows path.
  const sep = worktree.includes('\\') ? '\\' : '/';
  return (
    worktree +
    sep +
    rest
      .replace(/^[\\/]+/, '')
      .split(/[\\/]/)
      .join(sep)
  );
}
