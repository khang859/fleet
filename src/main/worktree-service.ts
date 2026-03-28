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

    // Find next available worktree number
    const existing = await this.list(repoPath);
    const existingNames = new Set(existing.map((w) => w.branch));
    let n = 1;
    let branchName: string;
    do {
      branchName = `${repoName}-worktree-${n}`;
      n++;
    } while (existingNames.has(branchName));

    const worktreePath = join(base, branchName);
    log.info('creating worktree', { repoPath, worktreePath, branchName });

    await git.raw(['worktree', 'add', worktreePath, '-b', branchName]);

    return { worktreePath, branchName };
  }

  async remove(worktreePath: string): Promise<void> {
    // Find the main repo by navigating from worktree's .git file
    const git = simpleGit({ baseDir: worktreePath });
    const topLevel = (await git.raw(['rev-parse', '--show-toplevel'])).trim();

    const mainGit = simpleGit({ baseDir: topLevel });

    try {
      log.info('removing worktree', { worktreePath });
      await mainGit.raw(['worktree', 'remove', worktreePath]);
    } catch (err) {
      log.warn('worktree remove failed, trying --force', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      });
      await mainGit.raw(['worktree', 'remove', '--force', worktreePath]);
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
