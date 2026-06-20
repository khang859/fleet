import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import { join, posix } from 'path';
import { tmpdir } from 'os';
import type { WorkspaceKind, PrState, ChecksState, ConflictState } from '../../shared/kanban-types';
import { wslExePath } from '../wsl-service';
import { parseWslUncPath, toWslUncPath } from '../../shared/path-platform';

// --- WSL routing -----------------------------------------------------------
// A kanban repo whose path is a `\\wsl.localhost\<distro>\…` UNC string (what the
// Windows folder picker yields for a repo inside a distro) lives on the distro's
// own filesystem. Its `git`/`gh` must run *inside* the distro — Windows git.exe
// against a 9P UNC cwd is unreliable, and we want the distro's git config + the
// repo's true POSIX path. Everything else runs natively, byte-for-byte unchanged.
//
// Paths cross the boundary in two coordinate systems: persisted/returned paths
// and filesystem ops (mkdir/rm/existsSync) use the **UNC** form (Windows-
// accessible); paths handed to in-distro git use the **POSIX** form. The two
// helpers below translate between them; `parseWslUncPath` is the sole detector.

type WslLoc = { distro: string; posixPath: string };

function wslOf(p: string | undefined | null): WslLoc | null {
  if (!p) return null;
  const u = parseWslUncPath(p);
  return u ? { distro: u.distro, posixPath: u.posixPath } : null;
}

/** A path as in-distro git must see it: POSIX for a WSL UNC path, else unchanged. */
function toGitPath(p: string): string {
  return wslOf(p)?.posixPath ?? p;
}

/** Resolve `git -C <target> <args>` to run natively or inside the target's distro. */
function gitArgv(target: string, args: string[]): { file: string; argv: string[] } {
  const w = wslOf(target);
  if (w) {
    return {
      file: wslExePath(),
      argv: ['-d', w.distro, '--exec', 'git', '-C', w.posixPath, ...args]
    };
  }
  return { file: 'git', argv: ['-C', target, ...args] };
}

/** `git -C <target> <args>` returning stdout as a string (encoding utf8). */
function gitStr(target: string, args: string[], extra: ExecFileSyncOptions = {}): string {
  const { file, argv } = gitArgv(target, args);
  return execFileSync(file, argv, { ...extra, encoding: 'utf8' });
}

/** `git -C <target> <args>` discarding stdout; throws (with stderr) on non-zero. */
function gitVoid(
  target: string,
  args: string[],
  extra: ExecFileSyncOptions = { stdio: 'ignore' }
): void {
  const { file, argv } = gitArgv(target, args);
  execFileSync(file, argv, extra);
}

/** Resolve `gh <args>` (run in `cwd`) to run natively or inside the cwd's distro. */
function ghArgv(cwd: string, args: string[]): { file: string; argv: string[]; spawnCwd?: string } {
  const w = wslOf(cwd);
  if (w) {
    return {
      file: wslExePath(),
      argv: ['-d', w.distro, '--cd', w.posixPath, '--exec', 'gh', ...args]
    };
  }
  return { file: 'gh', argv: args, spawnCwd: cwd };
}

function ghStr(cwd: string, args: string[], extra: ExecFileSyncOptions = {}): string {
  const { file, argv, spawnCwd } = ghArgv(cwd, args);
  return execFileSync(file, argv, { ...extra, cwd: spawnCwd, encoding: 'utf8' });
}

function ghVoid(cwd: string, args: string[], extra: ExecFileSyncOptions = {}): void {
  const { file, argv, spawnCwd } = ghArgv(cwd, args);
  execFileSync(file, argv, { ...extra, cwd: spawnCwd });
}

// Distro home is resolved once per distro (a cold distro boots on first call, so
// this also guarantees the VM is up before the UNC mkdir below). Synchronous to
// match the rest of this module (it runs inside the dispatcher tick).
const wslHomeCache = new Map<string, string>();
function wslHomeDir(distro: string): string {
  const cached = wslHomeCache.get(distro);
  if (cached) return cached;
  const home =
    execFileSync(wslExePath(), ['-d', distro, '--exec', 'sh', '-c', 'echo "$HOME"'], {
      encoding: 'utf8',
      timeout: 30_000
    }).trim() || '/root';
  wslHomeCache.set(distro, home);
  return home;
}

/**
 * Worktree root for a repo. A WSL repo's worktrees must sit on the distro's own
 * filesystem (fast ext4, not the 9P-mounted Windows root), so they go under the
 * distro home; returned as a UNC path so Windows fs ops + persistence work. A
 * native repo keeps the caller-supplied root unchanged.
 */
function worktreeRootFor(repoPath: string, nativeRoot: string): string {
  const w = wslOf(repoPath);
  if (!w) return nativeRoot;
  return toWslUncPath(w.distro, posix.join(wslHomeDir(w.distro), '.fleet', 'kanban', 'worktrees'));
}

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
    gitVoid(repoPath, ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The repo's current branch, or null if detached/unknown. */
function currentBranch(repoPath: string): string | null {
  try {
    const out = gitStr(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
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
  const out = gitStr(repoPath, ['branch', '--list', branch]);
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
  // For a WSL repo the worktree lives on the distro fs (UNC for fs/persistence);
  // `dirArg` is the POSIX form in-distro git is handed.
  const w = wslOf(repo);
  const root = worktreeRootFor(repo, input.worktreesRoot);
  const dir = w
    ? toWslUncPath(w.distro, posix.join(toGitPath(root), input.taskId))
    : join(root, input.taskId);
  const dirArg = toGitPath(dir);
  mkdirSync(root, { recursive: true });
  // Capture the repo's current branch up-front: it is the merge target and the
  // base a dependent child branches from. Fall back to the explicit start-point
  // when the child was told one (worktree create below honours the same).
  const base = input.startPoint ?? currentBranch(repo);
  const addArgs = branchExists(repo, branch)
    ? ['worktree', 'add', dirArg, branch]
    : input.startPoint
      ? ['worktree', 'add', dirArg, '-b', branch, input.startPoint]
      : ['worktree', 'add', dirArg, '-b', branch];
  try {
    gitVoid(repo, addArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // A failed `worktree add` can leave a partial dir + a stale registration;
    // remove both so a later retry can recreate cleanly.
    rmSync(dir, { recursive: true, force: true });
    try {
      gitVoid(repo, ['worktree', 'prune'], { stdio: 'ignore' });
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

/**
 * Create a worktree that checks out an EXISTING branch by name (no new -b branch).
 * Used by feature_sync system tasks whose worktree must BE the integration branch itself.
 */
export function checkoutBranchWorktree(input: {
  repoPath: string;
  branchName: string;
  worktreesRoot: string;
  taskId: string;
}): { path: string; branchName: string } {
  const w = wslOf(input.repoPath);
  const root = worktreeRootFor(input.repoPath, input.worktreesRoot);
  const dir = w
    ? toWslUncPath(w.distro, posix.join(toGitPath(root), input.taskId))
    : join(root, input.taskId);
  mkdirSync(root, { recursive: true });
  try {
    gitVoid(input.repoPath, ['worktree', 'add', toGitPath(dir), input.branchName], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    try {
      gitVoid(input.repoPath, ['worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
    throw new Error(`checkoutBranchWorktree: git worktree add failed: ${gitStderr(err)}`);
  }
  return { path: dir, branchName: input.branchName };
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
    gitVoid(input.repoPath, ['merge-base', '--is-ancestor', input.branchName, input.baseBranch], {
      stdio: 'ignore'
    });
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
    gitVoid(input.repoPath, ['worktree', 'remove', '--force', toGitPath(input.workspacePath)], {
      stdio: 'ignore'
    });
  } catch {
    // git remove failed (dir gone, repo moved, locked, ...). Clean the dir
    // directly and prune the stale registration so nothing is leaked.
    try {
      rmSync(input.workspacePath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      gitVoid(input.repoPath, ['worktree', 'prune'], { stdio: 'ignore' });
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
    gitVoid(input.repoPath, ['branch', '-D', input.branchName], { stdio: 'ignore' });
  } catch {
    // branch already gone or never created
  }
  return { branchKept: false };
}

/**
 * Commit counts of `branchName` relative to `baseBranch` plus whether the branch is
 * already merged (an ancestor of base, i.e. safe to prune). All local, never throws —
 * a failed git call yields zeroes / not-merged so the manager degrades gracefully.
 */
export function worktreeStatus(input: {
  repoPath: string;
  branchName: string;
  baseBranch: string;
}): { ahead: number; behind: number; merged: boolean } {
  const { repoPath, branchName, baseBranch } = input;
  let ahead = 0;
  let behind = 0;
  try {
    // `--left-right --count base...branch` → "<base-only>\t<branch-only>" = "<behind>\t<ahead>".
    const out = gitStr(
      repoPath,
      ['rev-list', '--left-right', '--count', `${baseBranch}...${branchName}`],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const [b, a] = out.trim().split(/\s+/).map(Number);
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  } catch {
    // base/branch ref missing — leave zeroes.
  }
  return { ahead, behind, merged: isBranchMerged({ repoPath, branchName, baseBranch }) };
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
    gitVoid(workspacePath, ['add', '-A'], { stdio: 'ignore' });
    // `git diff --cached --quiet` exits non-zero exactly when something is staged.
    let hasChanges = false;
    try {
      gitVoid(workspacePath, ['diff', '--cached', '--quiet'], { stdio: 'ignore' });
    } catch {
      hasChanges = true;
    }
    if (!hasChanges) return false;
    const msg = `kanban/${taskId}: ${title}`.slice(0, 200);
    try {
      gitVoid(workspacePath, ['commit', '-m', msg], { stdio: 'ignore' });
    } catch {
      // No git identity configured: commit with a Fleet fallback so work is still preserved.
      gitVoid(workspacePath, [...COMMIT_IDENTITY, 'commit', '-m', msg], { stdio: 'ignore' });
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
    const out = gitStr(input.workspacePath, ['diff', '--shortstat', `${input.baseBranch}...HEAD`]);
    return parseShortstat(out);
  } catch {
    return null;
  }
}

/** Current HEAD sha of a worktree, or null on error. */
export function headSha(workspacePath: string): string | null {
  try {
    return gitStr(workspacePath, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

/** Diff of a worktree branch vs its base, byte-capped with a truncation marker; '' on error. */
export function worktreeDiff(input: {
  workspacePath: string;
  baseBranch: string | null;
  maxBytes?: number;
}): string {
  if (!input.baseBranch) return '';
  const cap = input.maxBytes ?? 60000;
  try {
    const out = gitStr(input.workspacePath, ['diff', `${input.baseBranch}...HEAD`], {
      maxBuffer: 64 * 1024 * 1024
    });
    if (out.length <= cap) return out;
    return out.slice(0, cap) + '\n… (diff truncated)';
  } catch {
    return '';
  }
}

/** Path of the worktree that currently has `branch` checked out, or null. */
function findBranchWorktree(repoPath: string, branch: string): string | null {
  let out: string;
  try {
    out = gitStr(repoPath, ['worktree', 'list', '--porcelain']);
  } catch {
    return null;
  }
  // In-distro git reports POSIX paths; re-clothe them as UNC so downstream git
  // calls on the returned path re-detect the distro (and Windows fs ops work).
  const w = wslOf(repoPath);
  const toCoord = (p: string): string => (w ? toWslUncPath(w.distro, p) : p);
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line === `branch refs/heads/${branch}`) return current ? toCoord(current) : current;
  }
  return null;
}

/** True when a worktree has no staged/unstaged/untracked changes. */
function isClean(worktreePath: string): boolean {
  try {
    const out = gitStr(worktreePath, ['status', '--porcelain']);
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

function cleanupTempWorktree(repoPath: string, tmp: string): void {
  try {
    gitVoid(repoPath, ['worktree', 'remove', '--force', toGitPath(tmp)], { stdio: 'ignore' });
  } catch {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      gitVoid(repoPath, ['worktree', 'prune'], { stdio: 'ignore' });
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
      gitVoid(baseCheckout, [...COMMIT_IDENTITY, 'merge', '--no-ff', '-m', msg, branchName], {
        stdio: ['ignore', 'ignore', 'pipe']
      });
    } catch {
      try {
        gitVoid(baseCheckout, ['merge', '--abort'], { stdio: 'ignore' });
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
    gitVoid(repoPath, ['worktree', 'add', '--detach', toGitPath(tmp), baseBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return { ok: false, error: `could not create merge worktree: ${gitStderr(err)}` };
  }
  try {
    gitVoid(tmp, [...COMMIT_IDENTITY, 'merge', '--no-ff', '-m', msg, branchName], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch {
    try {
      gitVoid(tmp, ['merge', '--abort'], { stdio: 'ignore' });
    } catch {
      // nothing to abort
    }
    cleanupTempWorktree(repoPath, tmp);
    return { ok: false, conflict: true };
  }
  try {
    gitVoid(tmp, ['push', toGitPath(repoPath), `HEAD:refs/heads/${baseBranch}`], {
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
    gitVoid(workspacePath, ['push', '-u', 'origin', branchName], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return { ok: false, error: `git push failed (no 'origin' remote?): ${gitStderr(err)}` };
  }
  return ghPrCreate({ cwd: workspacePath, base: baseBranch, head: branchName, title, body });
}

/**
 * Open a PR via `gh pr create`, run in `cwd`. `gh` reports an already-existing PR
 * (with its URL) as an error, which we treat as success so the action is idempotent.
 */
function ghPrCreate(input: {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}): { ok: boolean; url?: string; number?: number; noGh?: boolean; error?: string } {
  try {
    const out = ghStr(input.cwd, [
      'pr',
      'create',
      '--base',
      input.base,
      '--head',
      input.head,
      '--title',
      input.title,
      '--body',
      input.body || input.title,
      ...(input.draft ? ['--draft'] : [])
    ]);
    const url = out.match(/https?:\/\/\S+/)?.[0] ?? out.trim();
    return { ok: true, url, number: prNumberFromUrl(url) };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        noGh: true,
        error: 'gh CLI not found. Install GitHub CLI to create PRs.'
      };
    }
    const msg = (e.stderr?.toString() || e.stdout?.toString() || (err as Error).message).trim();
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

/** Best start ref for cutting/merging a branch: origin/<base>, then <base>, then HEAD. */
function resolveStartRef(repoPath: string, base: string | undefined): string {
  if (base) {
    for (const ref of [`origin/${base}`, base]) {
      try {
        gitVoid(repoPath, ['rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' });
        return ref;
      } catch {
        // not present; try the next candidate
      }
    }
  }
  return 'HEAD';
}

/**
 * Create a feature's integration branch (`fleet/feature-<id>`) if absent, cut from
 * the local base (origin/<base>, else local <base>, else HEAD). Idempotent. No
 * network here on purpose — this runs inside the dispatcher tick, so a `git fetch`
 * would stall task claiming; remote freshness is handled off-tick by sync/ship.
 * Never pushed here either — that happens at ship time.
 */
export function ensureFeatureBranch(input: {
  repoPath: string;
  integrationBranch: string;
  baseBranch?: string | null;
}): { ok: boolean; error?: string } {
  const { repoPath, integrationBranch } = input;
  if (!isGitRepo(repoPath)) return { ok: false, error: `not a git repo: ${repoPath}` };
  if (branchExists(repoPath, integrationBranch)) return { ok: true };
  try {
    gitVoid(
      repoPath,
      ['branch', integrationBranch, resolveStartRef(repoPath, input.baseBranch ?? undefined)],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not create ${integrationBranch}: ${gitStderr(err)}` };
  }
}

/**
 * Predict whether `branchName` will merge cleanly into `baseBranch` without
 * touching either tree, via `git merge-tree --write-tree` (Git ≥2.38), returning
 * the conflicted paths when it won't. 'error' means the prediction itself failed
 * (older git, unknown ref) — not that a conflict exists.
 */
export function checkMergeConflicts(input: {
  repoPath: string;
  baseBranch: string;
  branchName: string;
}): { state: ConflictState; files: string[] } {
  const { repoPath, baseBranch, branchName } = input;
  try {
    gitVoid(repoPath, ['merge-tree', '--write-tree', '--no-messages', baseBranch, branchName], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { state: 'clean', files: [] };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer };
    // Exit 1 = the merge conflicts; conflicted entries are printed to stdout.
    if (e.status === 1) {
      return { state: 'conflicts', files: parseMergeTreeConflicts(e.stdout?.toString() ?? '') };
    }
    return { state: 'error', files: [] };
  }
}

/**
 * Pull conflicted paths from `git merge-tree --write-tree` output: after the
 * top-level tree OID, conflicting entries print as `<mode> <oid> <stage>\t<path>`
 * (one line per stage) — collect each distinct path.
 */
function parseMergeTreeConflicts(out: string): string[] {
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line);
    if (m) files.add(m[1]);
  }
  return [...files];
}

/**
 * Refresh a feature's integration branch with the latest base (main): fetch, and
 * if the branch is behind, merge the base into it inside a throwaway worktree so
 * no checkout is disturbed. Conflicts abort and are reported. Idempotent when the
 * integration branch already contains the base.
 */
export function updateIntegrationBranchFromMain(input: {
  repoPath: string;
  integrationBranch: string;
  baseBranch: string;
}): { ok: boolean; conflict?: boolean; alreadyUpToDate?: boolean; error?: string } {
  const { repoPath, integrationBranch, baseBranch } = input;
  try {
    gitVoid(repoPath, ['fetch', 'origin', baseBranch], { stdio: 'ignore' });
  } catch {
    // best-effort; fall back to the local base ref
  }
  const baseRef = resolveStartRef(repoPath, baseBranch);
  if (baseRef === 'HEAD') return { ok: false, error: `base branch not found: ${baseBranch}` };
  try {
    gitVoid(repoPath, ['merge-base', '--is-ancestor', baseRef, integrationBranch], {
      stdio: 'ignore'
    });
    return { ok: true, alreadyUpToDate: true };
  } catch {
    // base is ahead of the integration branch; merge it in below
  }
  // The sync worktree must sit on the repo's own filesystem: a distro path for a
  // WSL repo (the OS tmpdir is on the Windows side, a different filesystem), else
  // the native tmpdir as before.
  const safeBranch = integrationBranch.replace(/[^\w.-]/g, '_');
  const w = wslOf(repoPath);
  const tmp = w
    ? toWslUncPath(
        w.distro,
        posix.join(wslHomeDir(w.distro), '.fleet', 'kanban', `.sync-${safeBranch}`)
      )
    : join(tmpdir(), `fleet-sync-${safeBranch}`);
  cleanupTempWorktree(repoPath, tmp);
  try {
    gitVoid(repoPath, ['worktree', 'add', toGitPath(tmp), integrationBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return { ok: false, error: `could not create sync worktree: ${gitStderr(err)}` };
  }
  try {
    // The worktree has the integration branch checked out, so this advances its ref directly.
    gitVoid(
      tmp,
      [
        ...COMMIT_IDENTITY,
        'merge',
        '--no-ff',
        '-m',
        `merge ${baseBranch} into ${integrationBranch}`,
        baseRef
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch {
    try {
      gitVoid(tmp, ['merge', '--abort'], { stdio: 'ignore' });
    } catch {
      // nothing to abort
    }
    cleanupTempWorktree(repoPath, tmp);
    return { ok: false, conflict: true };
  }
  cleanupTempWorktree(repoPath, tmp);
  return { ok: true };
}

/**
 * Push a feature's integration branch to origin and open the single feature→main
 * PR via `gh`. The branch lives only in the local repo until now, so the push is
 * what publishes the whole feature as one reviewable unit.
 */
export function createFeaturePr(input: {
  repoPath: string;
  integrationBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}): {
  ok: boolean;
  url?: string;
  number?: number;
  noRemote?: boolean;
  noGh?: boolean;
  error?: string;
} {
  const { repoPath, integrationBranch, baseBranch, title, body, draft } = input;
  try {
    gitVoid(repoPath, ['push', '-u', 'origin', integrationBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (err) {
    return {
      ok: false,
      noRemote: true,
      error: `git push failed (no 'origin' remote?): ${gitStderr(err)}`
    };
  }
  return ghPrCreate({
    cwd: repoPath,
    base: baseBranch,
    head: integrationBranch,
    title,
    body,
    draft
  });
}

/**
 * Push a feature's integration branch to origin without touching its PR (the PR
 * updates itself from the pushed commits). Used for the 2nd+ task merge once the
 * draft PR already exists.
 */
export function pushIntegrationBranch(input: { repoPath: string; integrationBranch: string }): {
  ok: boolean;
  noRemote?: boolean;
  error?: string;
} {
  try {
    gitVoid(input.repoPath, ['push', 'origin', input.integrationBranch], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      noRemote: true,
      error: `git push failed (no 'origin' remote?): ${gitStderr(err)}`
    };
  }
}

/** Flip a draft PR to "ready for review" via `gh pr ready <number>`, run in repoPath. */
export function markPrReady(input: { repoPath: string; prNumber: number }): {
  ok: boolean;
  noGh?: boolean;
  error?: string;
} {
  try {
    ghVoid(input.repoPath, ['pr', 'ready', String(input.prNumber)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer; stdout?: Buffer };
    if (e.code === 'ENOENT') return { ok: false, noGh: true, error: 'gh CLI not found' };
    const msg = (e.stderr?.toString() || e.stdout?.toString() || (err as Error).message).trim();
    // `gh` errors when the PR is already non-draft; treat that as success (idempotent).
    if (/not a draft|already/i.test(msg)) return { ok: true };
    return { ok: false, error: `gh pr ready failed: ${msg}` };
  }
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
    out = ghStr(input.workspacePath, [
      'pr',
      'view',
      input.prRef,
      '--json',
      'state,isDraft,mergeStateStatus,statusCheckRollup,url,number'
    ]);
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
