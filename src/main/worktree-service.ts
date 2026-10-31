import { simpleGit } from 'simple-git';
import { join, posix as posixPath } from 'path';
import { mkdir, rm } from 'fs/promises';
import { createLogger } from './logger';
import { execInContext } from './run-in-context';
import { toWindowsAccessiblePath } from '../shared/path-platform';
import { isWslContext, type PathContext } from '../shared/shell-profiles';
import { WslService } from './wsl-service';
import { FLEET_HOME } from '../shared/constants';
import type {
  WorktreeCopySkip,
  WorktreePrepareResponse,
  WorktreeSetup,
  WorktreeSetupInfo
} from '../shared/ipc-api';
import {
  copyIgnoredPath,
  detectInstallCommand,
  ENV_PATHSPECS,
  localPath,
  readWorktreeSetup,
  writeWorktreeSetup
} from './worktree-config';

const log = createLogger('worktree');

// A WSL distro can be cold-booting; give worktree git operations a wide timeout.
const WSL_GIT_TIMEOUT_MS = 30_000;

function getRepoName(repoPath: string): string {
  const parts = repoPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'repo';
}

const ADJECTIVES = [
  'bold',
  'calm',
  'cool',
  'dark',
  'deep',
  'fast',
  'free',
  'glad',
  'gold',
  'keen',
  'kind',
  'late',
  'lean',
  'live',
  'loud',
  'mild',
  'neat',
  'pale',
  'pure',
  'rare',
  'rich',
  'safe',
  'slim',
  'soft',
  'tall',
  'tidy',
  'true',
  'warm',
  'wide',
  'wild',
  'blue',
  'gray',
  'iron',
  'jade',
  'mint',
  'ruby',
  'sage',
  'teal',
  'zinc',
  'onyx'
];

const NOUNS = [
  'arch',
  'bark',
  'bolt',
  'cape',
  'cask',
  'clay',
  'cove',
  'dawn',
  'dune',
  'edge',
  'fern',
  'flax',
  'ford',
  'gate',
  'glen',
  'gust',
  'haze',
  'helm',
  'isle',
  'jade',
  'keel',
  'knot',
  'lake',
  'lark',
  'loom',
  'mast',
  'mesa',
  'mist',
  'moss',
  'node',
  'opal',
  'palm',
  'peak',
  'pine',
  'pond',
  'reef',
  'root',
  'sage',
  'sand',
  'silo',
  'star',
  'stem',
  'surf',
  'tide',
  'vale',
  'vine',
  'warp',
  'wave',
  'wick',
  'yard'
];

function generateWorktreeName(): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(NOUNS)}`;
}

export class WorktreeService {
  // Resolves the distro home for WSL worktree placement; lightweight (per-distro
  // cached). Defaults to a fresh instance so `new WorktreeService()` stays valid;
  // injectable for tests.
  constructor(private readonly wslService: WslService = new WslService()) {}

  /**
   * Run a git subcommand in `cwd`. For a WSL pane git runs *inside* the distro
   * (so it sees the distro's git config and the repo's true posix path); for a
   * native pane it stays on the byte-for-byte original simple-git path.
   */
  private async git(ctx: PathContext | undefined, cwd: string, args: string[]): Promise<string> {
    if (isWslContext(ctx)) {
      const res = await execInContext(ctx, 'git', args, { cwd, timeoutMs: WSL_GIT_TIMEOUT_MS });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `git ${args.join(' ')} failed (exit ${res.code})`);
      }
      return res.stdout;
    }
    return simpleGit({ baseDir: cwd }).raw(args);
  }

  /** Remove a directory, bridging to the UNC share for a WSL posix path. */
  private async rmDir(ctx: PathContext | undefined, dir: string): Promise<void> {
    await rm(localPath(ctx, dir), { recursive: true, force: true });
  }

  /**
   * Where worktrees for `repoName` live. Mirrors the native `~/.fleet/worktrees`
   * layout, but for a WSL repo it must sit on the distro's own filesystem (a
   * `git worktree` cannot span filesystems), so it goes under the distro's home.
   */
  private async worktreeBase(ctx: PathContext | undefined, repoName: string): Promise<string> {
    if (isWslContext(ctx)) {
      const home = await this.wslService.homeDir(ctx.distro);
      return posixPath.join(home, '.fleet', 'worktrees', repoName);
    }
    return join(FLEET_HOME, 'worktrees', repoName);
  }

  /**
   * `branch` names the new branch; without it, a free `<repo>-<adjective>-<noun>`
   * is picked. `startPoint` is the commit it starts from, so worktrees made
   * apart start alike; without it, the main checkout's HEAD.
   */
  async create(
    repoPath: string,
    ctx?: PathContext,
    branch?: string,
    startPoint?: string
  ): Promise<{ worktreePath: string; branchName: string }> {
    const repoName = getRepoName(repoPath);
    const base = await this.worktreeBase(ctx, repoName);
    // Create the base on the repo's filesystem (UNC bridge for a WSL home).
    await mkdir(isWslContext(ctx) ? toWindowsAccessiblePath(base, ctx) : base, { recursive: true });

    // Check both existing worktree names AND branch names to avoid conflicts
    const existing = await this.list(repoPath, ctx);
    const existingWorktreeNames = new Set(existing.map((w) => w.branch));
    log.info('existing worktrees', { names: [...existingWorktreeNames] });

    const branchListRaw = await this.git(ctx, repoPath, [
      'branch',
      '--list',
      '--format=%(refname:short)'
    ]);
    const existingBranches = new Set(branchListRaw.split('\n').filter(Boolean));
    log.info('existing branches', { branches: [...existingBranches] });

    let branchName: string;
    if (branch !== undefined) {
      if (existingWorktreeNames.has(branch) || existingBranches.has(branch)) {
        throw new Error(`A branch named ${branch} already exists.`);
      }
      // Throws on a name git would not take as a branch.
      await this.git(ctx, repoPath, ['check-ref-format', '--branch', branch]);
      branchName = branch;
    } else {
      let attempts = 0;
      do {
        branchName = `${repoName}-${generateWorktreeName()}`;
        attempts++;
      } while (
        (existingWorktreeNames.has(branchName) || existingBranches.has(branchName)) &&
        attempts < 100
      );
    }

    // One folder per worktree, even for a branch name with slashes in it.
    const folder = branchName.replaceAll('/', '-');
    // posix join for WSL so the path git sees inside the distro stays posix.
    const worktreePath = isWslContext(ctx) ? posixPath.join(base, folder) : join(base, folder);
    log.info('creating worktree', { repoPath, worktreePath, branchName });

    const start = startPoint === undefined ? [] : [await this.commitOf(ctx, repoPath, startPoint)];
    await this.git(ctx, repoPath, ['worktree', 'add', worktreePath, '-b', branchName, ...start]);

    return { worktreePath, branchName };
  }

  /** The sha a ref names. Throws on one that is not a commit, before anything is made. */
  private async commitOf(
    ctx: PathContext | undefined,
    repoPath: string,
    ref: string
  ): Promise<string> {
    const sha = (
      await this.git(ctx, repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])
    ).trim();
    if (sha === '') throw new Error(`${ref} is not a commit in ${getRepoName(repoPath)}.`);
    return sha;
  }

  async remove(worktreePath: string, ctx?: PathContext): Promise<void> {
    let mainRepoPath: string;
    let branchName: string;
    try {
      // --git-common-dir returns the main repo's .git dir (not the worktree's)
      const gitCommonDir = (
        await this.git(ctx, worktreePath, ['rev-parse', '--git-common-dir'])
      ).trim();
      // gitCommonDir is like "/path/to/repo/.git" — parent is the repo root
      mainRepoPath = isWslContext(ctx)
        ? posixPath.join(gitCommonDir, '..')
        : join(gitCommonDir, '..');
      log.info('resolved main repo', { worktreePath, mainRepoPath });
      // Asked before removal, since the folder name is not the branch name: a
      // branch with slashes has them replaced in its folder. Only the branch
      // this folder was made for is deleted, never one the user switched to
      // in it; none when detached.
      const current = (await this.git(ctx, worktreePath, ['branch', '--show-current'])).trim();
      const folder = worktreePath.split(/[\\/]/).pop();
      branchName = current !== '' && current.replaceAll('/', '-') === folder ? current : '';
    } catch {
      log.warn('worktree dir not accessible, cleaning up directory', { worktreePath });
      // Try to remove the directory directly if git can't resolve
      try {
        await this.rmDir(ctx, worktreePath);
        log.info('removed worktree directory', { worktreePath });
      } catch {
        log.warn('failed to remove worktree directory', { worktreePath });
      }
      return;
    }

    try {
      log.info('removing worktree', { worktreePath });
      await this.git(ctx, mainRepoPath, ['worktree', 'remove', worktreePath]);
    } catch (err) {
      log.warn('worktree remove failed, trying --force', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      });
      try {
        await this.git(ctx, mainRepoPath, ['worktree', 'remove', '--force', worktreePath]);
      } catch {
        log.warn('force remove failed, pruning and cleaning up manually', { worktreePath });
        await this.git(ctx, mainRepoPath, ['worktree', 'prune']);
        // Remove the directory manually
        try {
          await this.rmDir(ctx, worktreePath);
        } catch {
          // ignore
        }
      }
    }

    // Clean up the branch too
    try {
      if (branchName !== '') {
        log.info('deleting branch', { branchName });
        await this.git(ctx, mainRepoPath, ['branch', '-D', branchName]);
      }
    } catch {
      // Branch may already be deleted or not exist
    }
  }

  /** What the new-worktree dialog offers: the branches to start from, and the setup file. */
  async prepare(repoPath: string, ctx?: PathContext): Promise<WorktreePrepareResponse> {
    const [current, local, remote, setup] = await Promise.all([
      this.git(ctx, repoPath, ['branch', '--show-current']),
      this.refNames(ctx, repoPath, 'refs/heads/'),
      this.refNames(ctx, repoPath, 'refs/remotes/'),
      this.resolveSetup(repoPath, ctx)
    ]);

    return {
      current: current.trim() || null,
      // `origin/HEAD` only points at another remote branch.
      refs: [...local, ...remote.filter((ref) => !ref.endsWith('/HEAD'))],
      ...setup
    };
  }

  /** The repository's setup file; without one, the setup Fleet detects for it. */
  private async resolveSetup(repoPath: string, ctx?: PathContext): Promise<WorktreeSetupInfo> {
    const read = await readWorktreeSetup(repoPath, ctx);
    if (read.setup !== null || read.setupError !== null) return { ...read, detected: false };

    const setup = await this.detectSetup(repoPath, ctx);
    return { setup, setupError: null, detected: setup !== null };
  }

  /** The lockfile's install command and the ignored `.env` files; null when there are neither. */
  private async detectSetup(repoPath: string, ctx?: PathContext): Promise<WorktreeSetup | null> {
    const setup = detectInstallCommand(repoPath, ctx);
    const ignored = await this.ignoredPaths(ctx, repoPath, ENV_PATHSPECS);
    // A trailing slash is a folder: `node_modules/`, or a virtualenv named `.env/`.
    const copy = ignored.filter((path) => !path.endsWith('/'));

    return setup === '' && copy.length === 0 ? null : { setup, copy };
  }

  /** Save the detected setup as the repository's setup file, and return what it now has. */
  async saveSetup(repoPath: string, ctx?: PathContext): Promise<WorktreeSetupInfo> {
    const setup = await this.detectSetup(repoPath, ctx);
    if (setup === null) throw new Error('Fleet found nothing to put in the setup file.');

    await writeWorktreeSetup(repoPath, setup, ctx);
    return { setup, setupError: null, detected: false };
  }

  /**
   * The git-ignored paths `pathspecs` match. A wholly ignored folder is one
   * entry with a trailing slash, and git does not look inside it.
   */
  private async ignoredPaths(
    ctx: PathContext | undefined,
    repoPath: string,
    pathspecs: string[]
  ): Promise<string[]> {
    const raw = await this.git(ctx, repoPath, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--',
      ...pathspecs
    ]);
    return raw.split('\0').filter(Boolean);
  }

  /** Branch names under `prefix`, without it, most recent commit first. */
  private async refNames(
    ctx: PathContext | undefined,
    repoPath: string,
    prefix: string
  ): Promise<string[]> {
    const raw = await this.git(ctx, repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)',
      prefix
    ]);
    return raw
      .split('\n')
      .filter(Boolean)
      .map((ref) => ref.slice(prefix.length));
  }

  /**
   * Copy the git-ignored files the setup lists, like `.env`, from the main
   * checkout into a new worktree. A path that git tracks, that is missing, or
   * that the worktree already has is skipped, so no file git knows is overwritten.
   */
  async copyFromMain(
    repoPath: string,
    worktreePath: string,
    ctx?: PathContext
  ): Promise<{ copied: string[]; skipped: WorktreeCopySkip[] }> {
    const { setup } = await this.resolveSetup(repoPath, ctx);
    if (setup === null || setup.copy.length === 0) return { copied: [], skipped: [] };

    const ignored = await this.ignoredPaths(ctx, repoPath, setup.copy);

    const copied: string[] = [];
    const skipped: WorktreeCopySkip[] = [];
    for (const path of setup.copy) {
      const reason = await copyIgnoredPath(ctx, repoPath, worktreePath, path, ignored);
      if (reason === null) copied.push(path);
      else skipped.push({ path, reason });
    }
    log.info('copied into worktree', { worktreePath, copied, skipped });
    return { copied, skipped };
  }

  async list(
    repoPath: string,
    ctx?: PathContext
  ): Promise<Array<{ path: string; branch: string }>> {
    const raw = await this.git(ctx, repoPath, ['worktree', 'list', '--porcelain']);
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
