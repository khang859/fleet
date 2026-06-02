import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { WorkspaceKind, PrState, ChecksState } from '../../shared/kanban-types';

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
  /**
   * Explicit start-point for a new worktree branch (a dependent child branches
   * from its prerequisite's merge target). Defaults to the repo's current HEAD.
   */
  startPoint?: string;
}

export interface PreparedWorkspace {
  path: string;
  branchName: string | null;
  /** Repo HEAD at worktree-creation time (the merge target). Null for scratch/dir/reuse. */
  baseBranch: string | null;
}

function isGitRepo(repoPath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The repo's current branch, or null if detached/unknown. */
function currentBranch(repoPath: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

/** stderr text from a failed execFileSync, falling back to the error message. */
function gitStderr(err: unknown): string {
  const e = err as { stderr?: Buffer };
  return e.stderr?.toString().trim() || (err as Error).message;
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
    return { path, branchName: null, baseBranch: null };
  }

  if (input.kind === 'dir') {
    if (!input.workspacePath) {
      throw new Error("prepareWorkspace: kind 'dir' requires an explicit workspacePath");
    }
    return { path: input.workspacePath, branchName: null, baseBranch: null };
  }

  // worktree
  if (input.workspacePath && existsSync(input.workspacePath)) {
    return { path: input.workspacePath, branchName: input.branchName ?? null, baseBranch: null };
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
  // Capture the repo's current branch up-front: it is the merge target and the
  // base a dependent child branches from. Fall back to the explicit start-point
  // when the child was told one (worktree create below honours the same).
  const base = input.startPoint ?? currentBranch(repo);
  const addArgs = branchExists(repo, branch)
    ? ['-C', repo, 'worktree', 'add', dir, branch]
    : input.startPoint
      ? ['-C', repo, 'worktree', 'add', dir, '-b', branch, input.startPoint]
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
  return { path: dir, branchName: branch, baseBranch: base };
}

export function cleanupWorkspace(input: { kind: WorkspaceKind; path: string }): void {
  // Only scratch is ephemeral; dir/worktree are preserved.
  if (input.kind === 'scratch') {
    rmSync(input.path, { recursive: true, force: true });
  }
}

/** True when `branchName` is already contained in `baseBranch` (no unmerged work). */
export function isBranchMerged(input: {
  repoPath: string;
  branchName: string;
  baseBranch: string;
}): boolean {
  try {
    execFileSync(
      'git',
      ['-C', input.repoPath, 'merge-base', '--is-ancestor', input.branchName, input.baseBranch],
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort teardown of a worktree-kind workspace: always remove the worktree
 * dir (free disk), but only delete the branch when it is already merged into
 * `baseBranch`. An unmerged branch is kept so archival never silently destroys
 * work — the returned `branchKept` lets the caller warn. Never throws.
 */
export function removeWorktree(input: {
  repoPath: string;
  workspacePath: string;
  branchName: string | null;
  baseBranch?: string | null;
}): { branchKept: boolean } {
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
  if (!input.branchName) return { branchKept: false };
  // Only `git branch -D` when the work is preserved elsewhere (merged into base).
  // Without a known base we cannot prove it is safe, so keep the branch.
  const merged = input.baseBranch
    ? isBranchMerged({
        repoPath: input.repoPath,
        branchName: input.branchName,
        baseBranch: input.baseBranch
      })
    : false;
  if (!merged) return { branchKept: true };
  try {
    execFileSync('git', ['-C', input.repoPath, 'branch', '-D', input.branchName], {
      stdio: 'ignore'
    });
  } catch {
    // branch already gone or never created
  }
  return { branchKept: false };
}

const COMMIT_IDENTITY = ['-c', 'user.name=Fleet', '-c', 'user.email=fleet@localhost'];

/**
 * Commit any uncommitted changes in a worktree so a run never leaves work only
 * in the working tree. Returns true when a commit was created. Never throws —
 * preservation is best-effort.
 */
export function finalizeWorktree(input: {
  workspacePath: string;
  taskId: string;
  title: string;
}): boolean {
  const { workspacePath, taskId, title } = input;
  try {
    execFileSync('git', ['-C', workspacePath, 'add', '-A'], { stdio: 'ignore' });
    // `git diff --cached --quiet` exits non-zero exactly when something is staged.
    let hasChanges = false;
    try {
      execFileSync('git', ['-C', workspacePath, 'diff', '--cached', '--quiet'], {
        stdio: 'ignore'
      });
    } catch {
      hasChanges = true;
    }
    if (!hasChanges) return false;
    const msg = `kanban/${taskId}: ${title}`.slice(0, 200);
    try {
      execFileSync('git', ['-C', workspacePath, 'commit', '-m', msg], { stdio: 'ignore' });
    } catch {
      // No git identity configured: commit with a Fleet fallback so work is still preserved.
      execFileSync('git', ['-C', workspacePath, ...COMMIT_IDENTITY, 'commit', '-m', msg], {
        stdio: 'ignore'
      });
    }
    return true;
  } catch {
    return false;
  }
}

export interface ReviewStat {
  files: number;
  insertions: number;
  deletions: number;
}

function parseShortstat(s: string): ReviewStat {
  const files = /(\d+) files? changed/.exec(s);
  const ins = /(\d+) insertions?\(\+\)/.exec(s);
  const del = /(\d+) deletions?\(-\)/.exec(s);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0
  };
}

/** Diff stat of a worktree's branch against its base, or null if unavailable. */
export function reviewStat(input: {
  workspacePath: string;
  baseBranch: string | null;
}): ReviewStat | null {
  if (!input.baseBranch) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', input.workspacePath, 'diff', '--shortstat', `${input.baseBranch}...HEAD`],
      { encoding: 'utf8' }
    );
    return parseShortstat(out);
  } catch {
    return null;
  }
}

/** Path of the worktree that currently has `branch` checked out, or null. */
function findBranchWorktree(repoPath: string, branch: string): string | null {
  let out: string;
  try {
    out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8'
    });
  } catch {
    return null;
  }
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/** True when a worktree has no staged/unstaged/untracked changes. */
function isClean(worktreePath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8'
    });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

function cleanupTempWorktree(repoPath: string, tmp: string): void {
  try {
    execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', tmp], {
      stdio: 'ignore'
    });
  } catch {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      // best-effort
    }
  }
}

/**
 * Merge `branchName` into `baseBranch`. `git push` refuses to update a branch
 * checked out in a non-bare repo, which is the common case (the base branch is
 * usually the user's own checkout), so the strategy depends on where base lives:
 *
 * - Base checked out somewhere → merge in place there, but only when that
 *   working tree is clean (a clean tree stays clean — the merge just advances
 *   it). If it is dirty we refuse rather than clobber uncommitted work.
 * - Base not checked out anywhere → merge in a throwaway detached worktree and
 *   push the result into the base ref, leaving every checkout untouched.
 *
 * A conflicting merge is aborted (restoring the working tree) and reported.
 */
export function mergeWorktreeToBase(input: {
  repoPath: string;
  branchName: string;
  baseBranch: string;
  worktreeParentDir: string;
  taskId: string;
  title: string;
}): { ok: boolean; conflict?: boolean; error?: string } {
  const { repoPath, branchName, baseBranch, worktreeParentDir, taskId, title } = input;
  const msg = `kanban/${taskId}: merge ${title}`.slice(0, 200);

  const baseCheckout = findBranchWorktree(repoPath, baseBranch);
  if (baseCheckout) {
    if (!isClean(baseCheckout)) {
      return {
        ok: false,
        error: `${baseBranch} is checked out with uncommitted changes at ${baseCheckout}; commit or stash them, then retry.`
      };
    }
    try {
      execFileSync(
        'git',
        ['-C', baseCheckout, ...COMMIT_IDENTITY, 'merge', '--no-ff', '-m', msg, branchName],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
    } catch {
      try {
        execFileSync('git', ['-C', baseCheckout, 'merge', '--abort'], { stdio: 'ignore' });
      } catch {
        // nothing to abort
      }
      return { ok: false, conflict: true };
    }
    return { ok: true };
  }

  const tmp = join(worktreeParentDir, `.merge-${taskId}`);
  cleanupTempWorktree(repoPath, tmp);
  try {
    execFileSync('git', ['-C', repoPath, 'worktree', 'add', '--detach', tmp, baseBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return { ok: false, error: `could not create merge worktree: ${gitStderr(err)}` };
  }
  try {
    execFileSync(
      'git',
      ['-C', tmp, ...COMMIT_IDENTITY, 'merge', '--no-ff', '-m', msg, branchName],
      {
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );
  } catch {
    try {
      execFileSync('git', ['-C', tmp, 'merge', '--abort'], { stdio: 'ignore' });
    } catch {
      // nothing to abort
    }
    cleanupTempWorktree(repoPath, tmp);
    return { ok: false, conflict: true };
  }
  try {
    execFileSync('git', ['-C', tmp, 'push', repoPath, `HEAD:refs/heads/${baseBranch}`], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    cleanupTempWorktree(repoPath, tmp);
    return {
      ok: false,
      error: `merged cleanly but could not update ${baseBranch}: ${gitStderr(err)}`
    };
  }
  cleanupTempWorktree(repoPath, tmp);
  return { ok: true };
}

/**
 * Push the worktree's branch to origin and open a PR via the `gh` CLI. Returns
 * the PR URL on success, or a graceful error when there is no remote / `gh` is
 * missing / the PR cannot be created.
 */
export function pushAndCreatePr(input: {
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}): { ok: boolean; url?: string; number?: number; error?: string } {
  const { workspacePath, branchName, baseBranch, title, body } = input;
  try {
    execFileSync('git', ['-C', workspacePath, 'push', '-u', 'origin', branchName], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return { ok: false, error: `git push failed (no 'origin' remote?): ${gitStderr(err)}` };
  }
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        branchName,
        '--title',
        title,
        '--body',
        body || title
      ],
      { cwd: workspacePath, encoding: 'utf8' }
    );
    const url = out.match(/https?:\/\/\S+/)?.[0] ?? out.trim();
    return { ok: true, url, number: prNumberFromUrl(url) };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'gh CLI not found. Install GitHub CLI to create PRs.' };
    }
    const msg = (e.stderr?.toString() || e.stdout?.toString() || (err as Error).message).trim();
    // `gh` reports an existing PR (with its URL) as an error — treat that as success.
    const existing = msg.match(/https?:\/\/\S+/)?.[0];
    if (existing) return { ok: true, url: existing, number: prNumberFromUrl(existing) };
    return { ok: false, error: `gh pr create failed: ${msg}` };
  }
}

/** Extract the PR number from a GitHub PR URL (…/pull/<n>), or undefined. */
function prNumberFromUrl(url: string | undefined): number | undefined {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** Normalize a single gh statusCheckRollup entry into pass/fail/pending. */
function classifyCheck(e: {
  status?: string;
  conclusion?: string;
  state?: string;
}): 'fail' | 'pass' | 'pending' {
  const concl = (e.conclusion ?? '').toUpperCase();
  const state = (e.state ?? '').toUpperCase();
  const FAIL = [
    'FAILURE',
    'TIMED_OUT',
    'CANCELLED',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
    'ERROR'
  ];
  const PASS = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
  if (FAIL.includes(concl) || FAIL.includes(state)) return 'fail';
  if (PASS.includes(concl) || PASS.includes(state)) return 'pass';
  // CheckRun still running, or a pending/expected status context.
  return 'pending';
}

/** Roll a gh statusCheckRollup array up to a single summary state (null when empty). */
function rollupChecks(rollup: unknown): ChecksState | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let pending = false;
  for (const raw of rollup) {
    const verdict = classifyCheck(raw as { status?: string; conclusion?: string; state?: string });
    if (verdict === 'fail') return 'failing';
    if (verdict === 'pending') pending = true;
  }
  return pending ? 'pending' : 'passing';
}

export type PrFetchResult =
  | {
      ok: true;
      state: PrState;
      checksState: ChecksState | null;
      mergeState: string | null;
      url: string;
      number: number;
    }
  | { ok: false; notFound?: boolean; noGh?: boolean; rateLimited?: boolean; error: string };

/**
 * Read a PR's current state from `gh`. `prRef` is a PR number or branch name;
 * the lookup runs in `workspacePath` so it resolves against that repo's origin.
 * Errors are tagged so the poller can react (drop a vanished PR, back off on
 * rate limits) without parsing strings itself.
 */
export function fetchPrState(input: { workspacePath: string; prRef: string }): PrFetchResult {
  let out: string;
  try {
    out = execFileSync(
      'gh',
      [
        'pr',
        'view',
        input.prRef,
        '--json',
        'state,isDraft,mergeStateStatus,statusCheckRollup,url,number'
      ],
      { cwd: input.workspacePath, encoding: 'utf8' }
    );
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') return { ok: false, noGh: true, error: 'gh CLI not found' };
    const msg = (e.stderr?.toString() || e.stdout?.toString() || (err as Error).message).trim();
    if (/no pull requests found|could not resolve|not found/i.test(msg)) {
      return { ok: false, notFound: true, error: msg };
    }
    if (/rate limit/i.test(msg)) return { ok: false, rateLimited: true, error: msg };
    return { ok: false, error: msg };
  }
  let json: {
    state?: string;
    isDraft?: boolean;
    mergeStateStatus?: string;
    statusCheckRollup?: unknown;
    url?: string;
    number?: number;
  };
  try {
    json = JSON.parse(out) as typeof json;
  } catch {
    return { ok: false, error: 'could not parse gh pr view output' };
  }
  const raw = (json.state ?? '').toUpperCase();
  const state: PrState = json.isDraft
    ? 'draft'
    : raw === 'MERGED'
      ? 'merged'
      : raw === 'CLOSED'
        ? 'closed'
        : 'open';
  return {
    ok: true,
    state,
    checksState: rollupChecks(json.statusCheckRollup),
    mergeState: json.mergeStateStatus ?? null,
    url: json.url ?? '',
    number: json.number ?? 0
  };
}
