import { simpleGit } from 'simple-git';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { createLogger } from './logger';

const log = createLogger('worktree');

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}

function getRepoName(repoPath: string): string {
  const parts = repoPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'repo';
}

export class WorktreeService {
  private getWorktreeBase(repoName: string): string {
    return join(getHomeDir(), '.fleet', 'worktrees', repoName);
  }

  async create(repoPath: string): Promise<{ worktreePath: string; branchName: string }> {
    const git = simpleGit({ baseDir: repoPath });
    const repoName = getRepoName(repoPath);
    const base = this.getWorktreeBase(repoName);
    await mkdir(base, { recursive: true });

    // Check both existing worktree names AND branch names to avoid conflicts
    const existing = await this.list(repoPath);
    const existingWorktreeNames = new Set(existing.map((w) => w.branch));
    log.info('existing worktrees', { names: [...existingWorktreeNames] });

    const branchListRaw = await git.raw(['branch', '--list', '--format=%(refname:short)']);
    const existingBranches = new Set(branchListRaw.split('\n').filter(Boolean));
    log.info('existing branches', { branches: [...existingBranches] });

    let n = 1;
    let branchName: string;
    do {
      branchName = `${repoName}-worktree-${n}`;
      log.debug('checking branch name', { branchName, inWorktrees: existingWorktreeNames.has(branchName), inBranches: existingBranches.has(branchName) });
      n++;
    } while (existingWorktreeNames.has(branchName) || existingBranches.has(branchName));

    const worktreePath = join(base, branchName);
    log.info('creating worktree', { repoPath, worktreePath, branchName });

    await git.raw(['worktree', 'add', worktreePath, '-b', branchName]);

    return { worktreePath, branchName };
  }

  async remove(worktreePath: string): Promise<void> {
    let mainRepoPath: string;
    try {
      // --git-common-dir returns the main repo's .git dir (not the worktree's)
      const git = simpleGit({ baseDir: worktreePath });
      const gitCommonDir = (await git.raw(['rev-parse', '--git-common-dir'])).trim();
      // gitCommonDir is like "/path/to/repo/.git" — parent is the repo root
      mainRepoPath = join(gitCommonDir, '..');
      log.info('resolved main repo', { worktreePath, mainRepoPath });
    } catch {
      log.warn('worktree dir not accessible, cleaning up directory', { worktreePath });
      // Try to remove the directory directly if git can't resolve
      try {
        const { rm } = await import('fs/promises');
        await rm(worktreePath, { recursive: true, force: true });
        log.info('removed worktree directory', { worktreePath });
      } catch {
        log.warn('failed to remove worktree directory', { worktreePath });
      }
      return;
    }

    const mainGit = simpleGit({ baseDir: mainRepoPath });

    try {
      log.info('removing worktree', { worktreePath });
      await mainGit.raw(['worktree', 'remove', worktreePath]);
    } catch (err) {
      log.warn('worktree remove failed, trying --force', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      });
      try {
        await mainGit.raw(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        log.warn('force remove failed, pruning and cleaning up manually', { worktreePath });
        await mainGit.raw(['worktree', 'prune']);
        // Remove the directory manually
        try {
          const { rm } = await import('fs/promises');
          await rm(worktreePath, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }

    // Clean up the branch too
    try {
      const branchName = worktreePath.split('/').pop();
      if (branchName) {
        log.info('deleting branch', { branchName });
        await mainGit.raw(['branch', '-D', branchName]);
      }
    } catch {
      // Branch may already be deleted or not exist
    }
  }

  async list(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
    const git = simpleGit({ baseDir: repoPath });
    const raw = await git.raw(['worktree', 'list', '--porcelain']);
    const worktrees: Array<{ path: string; branch: string }> = [];
    let currentPath = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        const branch = line.slice('branch refs/heads/'.length);
        worktrees.push({ path: currentPath, branch });
      }
    }

    return worktrees;
  }
}
