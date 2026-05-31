import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { WorkspaceKind } from '../../shared/kanban-types';

export interface PrepareWorkspaceInput {
  kind: WorkspaceKind;
  taskId: string;
  /** Root for ephemeral 'scratch' dirs. */
  workspacesRoot: string;
  /** Root for 'worktree' dirs (one per task id). */
  worktreesRoot: string;
  /** Current persisted working directory (explicit dir, or a created worktree). */
  workspacePath?: string;
  /** Source git repo for 'worktree' kind. */
  repoPath?: string;
  /** Current persisted branch (worktree reuse). */
  branchName?: string;
}

export interface PreparedWorkspace {
  path: string;
  branchName: string | null;
}

function isGitRepo(repoPath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// taskId is a generated id (no glob metacharacters), so `git branch --list <branch>`
// is an exact match here.
function branchExists(repoPath: string, branch: string): boolean {
  const out = execFileSync('git', ['-C', repoPath, 'branch', '--list', branch], {
    encoding: 'utf8'
  });
  return out.trim().length > 0;
}

/** Returns the working directory the worker should run in, plus its branch (if any). */
export function prepareWorkspace(input: PrepareWorkspaceInput): PreparedWorkspace {
  if (input.kind === 'scratch') {
    const path = join(input.workspacesRoot, input.taskId);
    mkdirSync(path, { recursive: true });
    return { path, branchName: null };
  }

  if (input.kind === 'dir') {
    if (!input.workspacePath) {
      throw new Error("prepareWorkspace: kind 'dir' requires an explicit workspacePath");
    }
    return { path: input.workspacePath, branchName: null };
  }

  // worktree
  if (input.workspacePath && existsSync(input.workspacePath)) {
    return { path: input.workspacePath, branchName: input.branchName ?? null };
  }
  if (!input.repoPath) {
    throw new Error("prepareWorkspace: kind 'worktree' requires repoPath");
  }
  const repo = input.repoPath;
  if (!isGitRepo(repo)) {
    throw new Error(`prepareWorkspace: not a git repo: ${repo}`);
  }
  const branch = `kanban/${input.taskId}`;
  const dir = join(input.worktreesRoot, input.taskId);
  mkdirSync(input.worktreesRoot, { recursive: true });
  const addArgs = branchExists(repo, branch)
    ? ['-C', repo, 'worktree', 'add', dir, branch]
    : ['-C', repo, 'worktree', 'add', dir, '-b', branch];
  try {
    execFileSync('git', addArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // A failed `worktree add` can leave a partial dir + a stale registration;
    // remove both so a later retry can recreate cleanly.
    rmSync(dir, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      // best-effort; ignore prune failures
    }
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
    throw new Error(
      `prepareWorkspace: git worktree add failed: ${stderr || (err as Error).message}`
    );
  }
  return { path: dir, branchName: branch };
}

export function cleanupWorkspace(input: { kind: WorkspaceKind; path: string }): void {
  // Only scratch is ephemeral; dir/worktree are preserved.
  if (input.kind === 'scratch') {
    rmSync(input.path, { recursive: true, force: true });
  }
}

/**
 * Best-effort teardown of a worktree-kind workspace: remove the worktree dir
 * and delete its branch. Never throws — archival must not be blocked by a git
 * failure. Directory cleanup is independent of the git calls, so a moved or
 * deleted repoPath does not leak the worktree dir.
 */
export function removeWorktree(input: {
  repoPath: string;
  workspacePath: string;
  branchName: string | null;
}): void {
  try {
    execFileSync(
      'git',
      ['-C', input.repoPath, 'worktree', 'remove', '--force', input.workspacePath],
      { stdio: 'ignore' }
    );
  } catch {
    // git remove failed (dir gone, repo moved, locked, ...). Clean the dir
    // directly and prune the stale registration so nothing is leaked.
    try {
      rmSync(input.workspacePath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      execFileSync('git', ['-C', input.repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      // best-effort
    }
  }
  if (input.branchName) {
    try {
      execFileSync('git', ['-C', input.repoPath, 'branch', '-D', input.branchName], {
        stdio: 'ignore'
      });
    } catch {
      // branch already gone or never created
    }
  }
}
