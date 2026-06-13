import { simpleGit } from 'simple-git';
import { join, posix as posixPath } from 'path';
import { mkdir, rm } from 'fs/promises';
import { createLogger } from './logger';
import { execInContext } from './run-in-context';
import { toWindowsAccessiblePath } from '../shared/path-platform';
import type { PathContext } from '../shared/shell-profiles';
import { WslService } from './wsl-service';

const log = createLogger('worktree');

// A WSL distro can be cold-booting; give worktree git operations a wide timeout.
const WSL_GIT_TIMEOUT_MS = 30_000;

// The only object variant of PathContext is the WSL one.
function isWslCtx(ctx: PathContext | undefined): ctx is { kind: 'wsl'; distro: string } {
  return typeof ctx === 'object';
}

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}

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
    if (isWslCtx(ctx)) {
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
    await rm(isWslCtx(ctx) ? toWindowsAccessiblePath(dir, ctx) : dir, {
      recursive: true,
      force: true
    });
  }

  /**
   * Where worktrees for `repoName` live. Mirrors the native `~/.fleet/worktrees`
   * layout, but for a WSL repo it must sit on the distro's own filesystem (a
   * `git worktree` cannot span filesystems), so it goes under the distro's home.
   */
  private async worktreeBase(ctx: PathContext | undefined, repoName: string): Promise<string> {
    if (isWslCtx(ctx)) {
      const home = await this.wslService.homeDir(ctx.distro);
      return posixPath.join(home, '.fleet', 'worktrees', repoName);
    }
    return join(getHomeDir(), '.fleet', 'worktrees', repoName);
  }

  async create(
    repoPath: string,
    ctx?: PathContext
  ): Promise<{ worktreePath: string; branchName: string }> {
    const repoName = getRepoName(repoPath);
    const base = await this.worktreeBase(ctx, repoName);
    // Create the base on the repo's filesystem (UNC bridge for a WSL home).
    await mkdir(isWslCtx(ctx) ? toWindowsAccessiblePath(base, ctx) : base, { recursive: true });

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
    let attempts = 0;
    do {
      branchName = `${repoName}-${generateWorktreeName()}`;
      attempts++;
    } while (
      (existingWorktreeNames.has(branchName) || existingBranches.has(branchName)) &&
      attempts < 100
    );

    // posix join for WSL so the path git sees inside the distro stays posix.
    const worktreePath = isWslCtx(ctx) ? posixPath.join(base, branchName) : join(base, branchName);
    log.info('creating worktree', { repoPath, worktreePath, branchName });

    await this.git(ctx, repoPath, ['worktree', 'add', worktreePath, '-b', branchName]);

    return { worktreePath, branchName };
  }

  async remove(worktreePath: string, ctx?: PathContext): Promise<void> {
    let mainRepoPath: string;
    try {
      // --git-common-dir returns the main repo's .git dir (not the worktree's)
      const gitCommonDir = (
        await this.git(ctx, worktreePath, ['rev-parse', '--git-common-dir'])
      ).trim();
      // gitCommonDir is like "/path/to/repo/.git" — parent is the repo root
      mainRepoPath = isWslCtx(ctx) ? posixPath.join(gitCommonDir, '..') : join(gitCommonDir, '..');
      log.info('resolved main repo', { worktreePath, mainRepoPath });
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
      const branchName = worktreePath.split('/').pop();
      if (branchName) {
        log.info('deleting branch', { branchName });
        await this.git(ctx, mainRepoPath, ['branch', '-D', branchName]);
      }
    } catch {
      // Branch may already be deleted or not exist
    }
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
