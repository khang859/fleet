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
    const branchListRaw = await git.raw(['branch', '--list', '--format=%(refname:short)']);
    const existingBranches = new Set(branchListRaw.split('\n').filter(Boolean));

    let n = 1;
    let branchName: string;
    do {
      branchName = `${repoName}-worktree-${n}`;
      n++;
    } while (existingWorktreeNames.has(branchName) || existingBranches.has(branchName));

    const worktreePath = join(base, branchName);
    log.info('creating worktree', { repoPath, worktreePath, branchName });

    await git.raw(['worktree', 'add', worktreePath, '-b', branchName]);

    return { worktreePath, branchName };
  }

  async remove(worktreePath: string): Promise<void> {
    let mainGit;
    try {
      // Try to resolve the main repo from the worktree path
      const git = simpleGit({ baseDir: worktreePath });
      const topLevel = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
      mainGit = simpleGit({ baseDir: topLevel });
    } catch {
      // Worktree dir may already be gone — try to find the main repo
      // by deriving it from the worktree path convention:
      // ~/.fleet/worktrees/{repoName}/{branchName}
      log.warn('worktree dir not accessible, will prune', { worktreePath });
      return;
    }

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
        // If force also fails, prune stale entries
        log.warn('force remove failed, pruning', { worktreePath });
        await mainGit.raw(['worktree', 'prune']);
      }
    }

    // Clean up the branch too
    try {
      const branchName = worktreePath.split('/').pop();
      if (branchName) {
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
