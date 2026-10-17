import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { RepoResolution } from '../../shared/agency';
import { isWslContext, type PathContext } from '../../shared/shell-profiles';
import { execInContext } from '../run-in-context';
import { gitExec, GIT_TIMEOUT_MS } from './exec';

/** Runs `git <args>` in `cwd`; resolves with the trimmed stdout, or null on any failure. */
export type GitRun = (args: string[], cwd: string) => Promise<string | null>;

/** The canonical path of a directory, or null when it does not exist. */
export type RealPath = (path: string) => Promise<string | null>;

export type RepoIdentityOptions = {
  /** The pane's path semantics. A WSL folder runs git inside the distro. */
  pathContext?: PathContext;
  /** The folder lives on another machine: an SSH pane or a remote browser. */
  remote?: boolean;
  /** Seams for tests; default to the host's git and filesystem. */
  git?: GitRun;
  realpath?: RealPath;
};

const nativeGit: GitRun = async (args, cwd) => (await gitExec(args, cwd))?.trim() ?? null;

const nativeRealpath: RealPath = async (path) => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

/** Runs a command inside a WSL distro; resolves with its trimmed stdout, or null. */
async function inWsl(
  ctx: Extract<PathContext, { kind: 'wsl' }>,
  cmd: string,
  args: string[],
  cwd?: string
): Promise<string | null> {
  try {
    const out = await execInContext(ctx, cmd, args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    return out.code === 0 ? out.stdout.trim() : null;
  } catch {
    return null;
  }
}

function wslGit(ctx: Extract<PathContext, { kind: 'wsl' }>): GitRun {
  return async (args, cwd) => inWsl(ctx, 'git', args, cwd);
}

function wslRealpath(ctx: Extract<PathContext, { kind: 'wsl' }>): RealPath {
  return async (path) => inWsl(ctx, 'realpath', ['--', path]);
}

/** A UNC path (`\\server\share`, `//server/share`) is a network folder, not a local one. */
function isUncPath(path: string): boolean {
  return /^(\\\\|\/\/)[^\\/]/.test(path);
}

/** The id an absolute, canonical git common dir is known by. */
export function repoIdFor(gitCommonDir: string): string {
  return createHash('sha256').update(gitCommonDir).digest('hex').slice(0, 16);
}

/**
 * The working tree that owns a common dir. A normal repository keeps its
 * common dir at `<root>/.git`, worktrees or not. A submodule keeps it under
 * the superproject's `.git/modules/<name>`, with `core.worktree` pointing back
 * at the submodule's checkout. A bare repository has neither, and no root.
 */
async function mainRoot(commonDir: string, cwd: string, git: GitRun): Promise<string | null> {
  if (basename(commonDir) === '.git') return dirname(commonDir);
  const worktree = await git(['--git-dir', commonDir, 'config', '--get', 'core.worktree'], cwd);
  if (worktree) return isAbsolute(worktree) ? worktree : resolve(commonDir, worktree);
  return null;
}

/**
 * Resolve the repository a folder belongs to, the same way from the main
 * checkout, any linked worktree of it, or any folder inside either: by the
 * realpath of `git rev-parse --git-common-dir`. A folder on another machine is
 * refused, since an Admiral runs its crew on this one.
 */
export async function resolveRepoIdentity(
  cwd: string,
  opts: RepoIdentityOptions = {}
): Promise<RepoResolution> {
  if (opts.remote === true || isUncPath(cwd)) return { ok: false, reason: 'remote' };
  const wsl = isWslContext(opts.pathContext) ? opts.pathContext : null;
  const git = opts.git ?? (wsl ? wslGit(wsl) : nativeGit);
  const canonical = opts.realpath ?? (wsl ? wslRealpath(wsl) : nativeRealpath);

  if (!wsl && opts.git === undefined) {
    // execFile with a missing cwd fails with a spawn error that says nothing
    // about the folder; checking first keeps "not a repository" the answer.
    const isDir = await stat(cwd).then(
      (s) => s.isDirectory(),
      () => false
    );
    if (!isDir) return { ok: false, reason: 'not-a-repo' };
  }

  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) return { ok: false, reason: 'not-a-repo' };
  const gitCommonDir = await canonical(common);
  if (!gitCommonDir) return { ok: false, reason: 'not-a-repo' };

  const rootPath = await mainRoot(gitCommonDir, cwd, git);
  const root = rootPath === null ? null : ((await canonical(rootPath)) ?? rootPath);
  if (root === null) return { ok: false, reason: 'not-a-repo' };

  return {
    ok: true,
    repoId: repoIdFor(gitCommonDir),
    root,
    name: basename(root),
    gitCommonDir,
    ...(await superproject(cwd, git, canonical, opts))
  };
}

/** The superproject a submodule sits in, and its id, or nulls for any other repository. */
async function superproject(
  cwd: string,
  git: GitRun,
  canonical: RealPath,
  opts: RepoIdentityOptions
): Promise<{ superprojectRoot: string | null; superprojectRepoId: string | null }> {
  const raw = await git(['rev-parse', '--show-superproject-working-tree'], cwd);
  if (!raw) return { superprojectRoot: null, superprojectRepoId: null };
  const superprojectRoot = (await canonical(raw)) ?? raw;
  const parent = await resolveRepoIdentity(superprojectRoot, { ...opts, remote: false });
  return { superprojectRoot, superprojectRepoId: parent.ok ? parent.repoId : null };
}
