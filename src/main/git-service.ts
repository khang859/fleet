import { simpleGit, type SimpleGit, type FileStatusResult } from 'simple-git';
import type {
  GitStatusPayload,
  GitIsRepoPayload,
  GitRepoRootPayload,
  GitFileStatus
} from '../shared/ipc-api';
import type { PathContext } from '../shared/shell-profiles';
import { execInContext, type ExecResult } from './run-in-context';

const GIT_TIMEOUT_MS = 20_000;

// The only object variant of PathContext is the WSL one.
function isWslCtx(ctx: PathContext | undefined): ctx is { kind: 'wsl'; distro: string } {
  return typeof ctx === 'object';
}

export class GitService {
  private getGit(cwd: string): SimpleGit {
    return simpleGit({ baseDir: cwd });
  }

  /** Run `git args...` inside the WSL distro at the (posix) repo cwd. */
  private async runWslGit(
    ctx: { kind: 'wsl'; distro: string },
    cwd: string,
    args: string[]
  ): Promise<ExecResult> {
    return execInContext(ctx, 'git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }

  async checkIsRepo(cwd: string, ctx?: PathContext): Promise<GitIsRepoPayload> {
    if (isWslCtx(ctx)) return this.checkIsRepoWsl(ctx, cwd);
    try {
      const isRepo = await this.getGit(cwd).checkIsRepo();
      return { isRepo };
    } catch {
      return { isRepo: false };
    }
  }

  async repoRoot(cwd: string, ctx?: PathContext): Promise<GitRepoRootPayload> {
    if (isWslCtx(ctx)) return this.repoRootWsl(ctx, cwd);
    try {
      const root = (await this.getGit(cwd).revparse(['--show-toplevel'])).trim();
      return { root: root || null };
    } catch {
      return { root: null };
    }
  }

  async getFullStatus(cwd: string, baseRef?: string, ctx?: PathContext): Promise<GitStatusPayload> {
    if (isWslCtx(ctx)) return this.getFullStatusWsl(ctx, cwd, baseRef);
    const git = this.getGit(cwd);

    // Check if it's a repo first
    try {
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { isRepo: false, branch: '', files: [], diff: '' };
      }
    } catch {
      return { isRepo: false, branch: '', files: [], diff: '' };
    }

    // When a base ref is given, show the branch's committed work (base...HEAD)
    // rather than working-tree changes — a finalized worktree has a clean tree.
    if (baseRef) {
      return this.getRefDiff(git, baseRef);
    }

    try {
      const [branchInfo, statusResult] = await Promise.all([git.branch(), git.status()]);

      const branch = branchInfo.current;
      const untrackedPaths = new Set(statusResult.not_added);

      // Get numstat for tracked file stats
      let numstatRaw = '';
      const hasTrackedChanges = statusResult.files.some((f) => !untrackedPaths.has(f.path));
      if (hasTrackedChanges) {
        numstatRaw = await git.raw(['diff', 'HEAD', '--numstat']);
      }

      // Parse numstat: "insertions\tdeletions\tpath"
      const numstatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const line of numstatRaw.split('\n')) {
        const parts = line.split('\t');
        if (parts.length === 3) {
          numstatMap.set(parts[2], {
            insertions: parseInt(parts[0]) || 0,
            deletions: parseInt(parts[1]) || 0
          });
        }
      }

      // Build file list
      const files: GitFileStatus[] = statusResult.files.map((f) => {
        const isUntracked = untrackedPaths.has(f.path);
        const stats = numstatMap.get(f.path) ?? { insertions: 0, deletions: 0 };
        return {
          path: f.path,
          status: resolveStatus(f, isUntracked),
          insertions: stats.insertions,
          deletions: stats.deletions
        };
      });

      // Get unified diff for tracked files
      let diff = '';
      if (hasTrackedChanges) {
        diff = await git.diff(['HEAD']);
      }

      // Append diffs for untracked files
      for (const path of untrackedPaths) {
        try {
          const untrackedDiff = await git.raw(['diff', '--no-index', '/dev/null', path]);
          diff += untrackedDiff;
        } catch (e: unknown) {
          // git diff --no-index exits with code 1 when files differ (which is always
          // the case for /dev/null vs a real file). simple-git throws on non-zero exit.
          // The stderr/stdout still contains the diff, so extract it from the error.
          if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
            const msg = e.message;
            // Extract the actual diff output from the error message
            const diffMatch = msg.match(/(diff --git[\s\S]*)/);
            if (diffMatch) {
              diff += diffMatch[1];
            }
          }
        }
      }

      return { isRepo: true, branch, files, diff };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { isRepo: true, branch: '', files: [], diff: '', error: message };
    }
  }

  /** Committed diff of the current branch against `baseRef` (three-dot: base...HEAD). */
  private async getRefDiff(git: SimpleGit, baseRef: string): Promise<GitStatusPayload> {
    const range = `${baseRef}...HEAD`;
    try {
      const branchInfo = await git.branch();
      const branch = branchInfo.current;
      const numstatRaw = await git.raw(['diff', range, '--numstat']);
      const nameStatusRaw = await git.raw(['diff', range, '--name-status']);

      const numstatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const line of numstatRaw.split('\n')) {
        const parts = line.split('\t');
        if (parts.length === 3) {
          // Renames appear as `dir/{old => new}/file` or a whole-path `old => new`
          // in the path column; collapse to the new path so name-status lookups match.
          let path = parts[2];
          const brace = path.match(/^(.*)\{.* => (.*?)\}(.*)$/);
          if (brace) path = brace[1] + brace[2] + brace[3];
          else if (path.includes(' => ')) path = path.split(' => ')[1];
          numstatMap.set(path, {
            insertions: parseInt(parts[0]) || 0,
            deletions: parseInt(parts[1]) || 0
          });
        }
      }

      const files: GitFileStatus[] = [];
      for (const line of nameStatusRaw.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0]?.[0] ?? 'M';
        const path = parts[parts.length - 1];
        const stats = numstatMap.get(path) ?? { insertions: 0, deletions: 0 };
        files.push({
          path,
          status:
            code === 'A'
              ? 'added'
              : code === 'D'
                ? 'deleted'
                : code === 'R'
                  ? 'renamed'
                  : 'modified',
          insertions: stats.insertions,
          deletions: stats.deletions
        });
      }

      const diff = await git.diff([range]);
      return { isRepo: true, branch, files, diff };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { isRepo: true, branch: '', files: [], diff: '', error: message };
    }
  }

  // ── WSL variants ────────────────────────────────────────────────────────
  // Run git inside the distro (see run-in-context.ts) rather than spawning the
  // Windows git.exe against a posix/UNC cwd. Returns posix paths.

  private async checkIsRepoWsl(
    ctx: { kind: 'wsl'; distro: string },
    cwd: string
  ): Promise<GitIsRepoPayload> {
    try {
      const { stdout, code } = await this.runWslGit(ctx, cwd, [
        'rev-parse',
        '--is-inside-work-tree'
      ]);
      return { isRepo: code === 0 && stdout.trim() === 'true' };
    } catch {
      return { isRepo: false };
    }
  }

  private async repoRootWsl(
    ctx: { kind: 'wsl'; distro: string },
    cwd: string
  ): Promise<GitRepoRootPayload> {
    try {
      const { stdout, code } = await this.runWslGit(ctx, cwd, ['rev-parse', '--show-toplevel']);
      return { root: code === 0 ? stdout.trim() || null : null };
    } catch {
      return { root: null };
    }
  }

  private async getFullStatusWsl(
    ctx: { kind: 'wsl'; distro: string },
    cwd: string,
    baseRef?: string
  ): Promise<GitStatusPayload> {
    const repo = await this.checkIsRepoWsl(ctx, cwd);
    if (!repo.isRepo) {
      return { isRepo: false, branch: '', files: [], diff: '' };
    }

    if (baseRef) {
      return this.getRefDiffWsl(ctx, cwd, baseRef);
    }

    try {
      const branch = (await this.runWslGit(ctx, cwd, ['branch', '--show-current'])).stdout.trim();
      const statusRaw = (
        await this.runWslGit(ctx, cwd, [
          '-c',
          'core.quotepath=false',
          'status',
          '--porcelain=v1',
          '--untracked-files=all'
        ])
      ).stdout;
      const { files: statusFiles, untracked } = parsePorcelainV1(statusRaw);

      const hasTrackedChanges = statusFiles.some((f) => !untracked.has(f.path));
      let numstatRaw = '';
      if (hasTrackedChanges) {
        numstatRaw = (
          await this.runWslGit(ctx, cwd, [
            '-c',
            'core.quotepath=false',
            'diff',
            'HEAD',
            '--numstat'
          ])
        ).stdout;
      }
      const numstatMap = parseNumstat(numstatRaw);

      const files: GitFileStatus[] = statusFiles.map((f) => {
        const isUntracked = untracked.has(f.path);
        const stats = numstatMap.get(f.path) ?? { insertions: 0, deletions: 0 };
        return {
          path: f.path,
          status: resolveStatus(f, isUntracked),
          insertions: stats.insertions,
          deletions: stats.deletions
        };
      });

      let diff = '';
      if (hasTrackedChanges) {
        diff = (await this.runWslGit(ctx, cwd, ['diff', 'HEAD'])).stdout;
      }

      // Untracked files: `git diff --no-index /dev/null <path>` exits 1 but
      // still prints the diff on stdout (no shell, so no exit-code throw here).
      for (const path of untracked) {
        const { stdout } = await this.runWslGit(ctx, cwd, [
          'diff',
          '--no-index',
          '/dev/null',
          path
        ]);
        diff += stdout;
      }

      return { isRepo: true, branch, files, diff };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { isRepo: true, branch: '', files: [], diff: '', error: message };
    }
  }

  private async getRefDiffWsl(
    ctx: { kind: 'wsl'; distro: string },
    cwd: string,
    baseRef: string
  ): Promise<GitStatusPayload> {
    const range = `${baseRef}...HEAD`;
    try {
      const branch = (await this.runWslGit(ctx, cwd, ['branch', '--show-current'])).stdout.trim();
      const numstatRaw = (
        await this.runWslGit(ctx, cwd, ['-c', 'core.quotepath=false', 'diff', range, '--numstat'])
      ).stdout;
      const nameStatusRaw = (
        await this.runWslGit(ctx, cwd, [
          '-c',
          'core.quotepath=false',
          'diff',
          range,
          '--name-status'
        ])
      ).stdout;

      const numstatMap = parseNumstatWithRename(numstatRaw);

      const files: GitFileStatus[] = [];
      for (const line of nameStatusRaw.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0]?.[0] ?? 'M';
        const path = parts[parts.length - 1];
        const stats = numstatMap.get(path) ?? { insertions: 0, deletions: 0 };
        files.push({
          path,
          status:
            code === 'A'
              ? 'added'
              : code === 'D'
                ? 'deleted'
                : code === 'R'
                  ? 'renamed'
                  : 'modified',
          insertions: stats.insertions,
          deletions: stats.deletions
        });
      }

      const diff = (await this.runWslGit(ctx, cwd, ['diff', range])).stdout;
      return { isRepo: true, branch, files, diff };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { isRepo: true, branch: '', files: [], diff: '', error: message };
    }
  }
}

/** Parse `git diff --numstat` text → path → {insertions, deletions}. */
function parseNumstat(raw: string): Map<string, { insertions: number; deletions: number }> {
  const map = new Map<string, { insertions: number; deletions: number }>();
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts.length === 3) {
      map.set(parts[2], {
        insertions: parseInt(parts[0]) || 0,
        deletions: parseInt(parts[1]) || 0
      });
    }
  }
  return map;
}

/**
 * Like {@link parseNumstat} but collapses rename path columns
 * (`dir/{old => new}/file` or `old => new`) to the new path so name-status
 * lookups match — used for ref-diffs where renames are detected.
 */
function parseNumstatWithRename(
  raw: string
): Map<string, { insertions: number; deletions: number }> {
  const map = new Map<string, { insertions: number; deletions: number }>();
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts.length === 3) {
      let path = parts[2];
      const brace = path.match(/^(.*)\{.* => (.*?)\}(.*)$/);
      if (brace) path = brace[1] + brace[2] + brace[3];
      else if (path.includes(' => ')) path = path.split(' => ')[1];
      map.set(path, {
        insertions: parseInt(parts[0]) || 0,
        deletions: parseInt(parts[1]) || 0
      });
    }
  }
  return map;
}

/**
 * Parse `git status --porcelain=v1` (with core.quotepath=false). Each line is
 * `XY <path>`, or `XY <orig> -> <path>` for renames/copies. Mirrors the shape
 * simple-git's `status()` returns (files + untracked set) so the WSL and native
 * code paths build identical payloads.
 */
function parsePorcelainV1(raw: string): {
  files: FileStatusResult[];
  untracked: Set<string>;
} {
  const files: FileStatusResult[] = [];
  const untracked = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue;
    const index = line[0];
    const working_dir = line[1];
    let path = line.slice(3);
    if (index === '?' && working_dir === '?') {
      untracked.add(path);
      files.push({ path, index, working_dir });
      continue;
    }
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    files.push({ path, index, working_dir });
  }
  return { files, untracked };
}

function resolveStatus(file: FileStatusResult, isUntracked: boolean): GitFileStatus['status'] {
  if (isUntracked) return 'untracked';
  // Check both index and working_dir status
  const combined = file.index + file.working_dir;
  if (combined.includes('R')) return 'renamed';
  if (combined.includes('A')) return 'added';
  if (combined.includes('D')) return 'deleted';
  return 'modified';
}
