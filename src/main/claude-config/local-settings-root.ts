import { simpleGit } from 'simple-git';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { LocalSettingsRootResult } from '../../shared/claude-config-types';

/**
 * Where Claude Code puts `settings.local.json` for a session in `sessionDir`.
 *
 * This is not the same directory the shared `settings.json` comes from, which
 * is the trap this module exists to avoid. Claude Code reads the shared file
 * from the session's working directory, but places the local file at the git
 * repository root - and in a worktree, at the *main checkout's* root, so one
 * set of personal approvals covers every worktree of the repository.
 *
 * Four documented cases send it back to the session directory instead: outside
 * a repository, when the root would be the home directory, on Windows, and on
 * an ownership mismatch. The first three are handled; ownership is not, because
 * it is rare, platform-specific, and the page always shows the resolved path
 * with a picker to correct it.
 *
 * The `rule` is returned alongside the path so the page can say which rule
 * produced it. These placement rules changed in Claude Code v2.1.211 and again
 * in v2.1.246, and Fleet cannot know which binary a given terminal runs, so a
 * visible path with a stated reason ages better than a silent guess.
 */
const GIT_TIMEOUT_MS = 10_000;

export async function resolveLocalSettingsRoot(
  sessionDir: string
): Promise<LocalSettingsRootResult> {
  const fallback: LocalSettingsRootResult = { root: sessionDir, rule: 'sessionDirectory' };

  // Claude Code keeps the local file beside the shared one on Windows, so
  // there is nothing to resolve and no reason to pay for a git call.
  if (process.platform === 'win32') return fallback;

  try {
    const git = simpleGit({ baseDir: sessionDir, timeout: { block: GIT_TIMEOUT_MS } });

    // `--git-common-dir` is the main checkout's `.git` even from inside a
    // worktree, where `--show-toplevel` would give the worktree's own root.
    // One call therefore covers both the plain-repository and worktree cases.
    const commonDir = (await git.revparse(['--path-format=absolute', '--git-common-dir'])).trim();
    if (!commonDir) return fallback;

    const mainRoot = dirname(resolve(commonDir));

    // A repository whose root is the home directory is one of the documented
    // cases where the local file stays with the shared file.
    if (mainRoot === resolve(homedir())) return fallback;

    // Distinguish "I am in a worktree" from "I am in the main checkout" purely
    // so the page can name the rule it used; the path is the same either way.
    const topLevel = (await git.revparse(['--show-toplevel'])).trim();
    const inWorktree = topLevel !== '' && resolve(topLevel) !== mainRoot;

    return { root: mainRoot, rule: inWorktree ? 'worktreeMainCheckout' : 'repositoryRoot' };
  } catch {
    // Not a repository, git missing, or a timeout. The session directory is
    // Claude Code's own fallback for the first of those and a safe answer for
    // the rest.
    return fallback;
  }
}
