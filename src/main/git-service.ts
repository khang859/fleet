import { simpleGit, type SimpleGit, type FileStatusResult } from 'simple-git';
import type {
  GitStatusPayload,
  GitIsRepoPayload,
  GitRepoRootPayload,
  GitFileStatus
} from '../shared/ipc-api';

export class GitService {
  private getGit(cwd: string): SimpleGit {
    return simpleGit({ baseDir: cwd });
  }

  async checkIsRepo(cwd: string): Promise<GitIsRepoPayload> {
    try {
      const isRepo = await this.getGit(cwd).checkIsRepo();
      return { isRepo };
    } catch {
      return { isRepo: false };
    }
  }

  async repoRoot(cwd: string): Promise<GitRepoRootPayload> {
    try {
      const root = (await this.getGit(cwd).revparse(['--show-toplevel'])).trim();
      return { root: root || null };
    } catch {
      return { root: null };
    }
  }

  async getFullStatus(cwd: string, baseRef?: string): Promise<GitStatusPayload> {
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
