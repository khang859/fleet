import { simpleGit } from 'simple-git';
import { join, posix as posixPath } from 'path';
import { mkdir, rm } from 'fs/promises';
import { createLogger } from './logger';
import { execInContext } from './run-in-context';
import { toWindowsAccessiblePath } from '../shared/path-platform';
import { isWslContext, type PathContext } from '../shared/shell-profiles';
import { WslService } from './wsl-service';
import { FLEET_HOME } from '../shared/constants';

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
    await rm(isWslContext(ctx) ? toWindowsAccessiblePath(dir, ctx) : dir, {
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

  /**
   * Remove a worktree the safe way, for agency cleanup: never forced, so git
   * refuses one with changes or untracked files, and its branch only when
   * another branch or a remote holds every commit on it. Throws when git
   * refuses, leaving the worktree as it was. Git runs in the repository's
   * git folder, not its parent: a submodule's is `.git/modules/<name>` of the
   * umbrella, whose parent is no checkout.
   */
  async removeClean(worktreePath: string, branch: string | null): Promise<void> {
    const mainRepoPath = (
      await this.git(undefined, worktreePath, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir'
      ])
    ).trim();
    await this.git(undefined, mainRepoPath, ['worktree', 'remove', worktreePath]);
    if (branch !== null) {
      const unsafe = (
        await this.git(undefined, mainRepoPath, [
          'rev-list',
          '--count',
          `refs/heads/${branch}`,
          '--not',
          `--exclude=${branch}`,
          '--branches',
          '--remotes'
        ])
      ).trim();
      if (unsafe === '0') await this.git(undefined, mainRepoPath, ['branch', '-D', branch]);
    }
    await this.git(undefined, mainRepoPath, ['worktree', 'prune']);
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
