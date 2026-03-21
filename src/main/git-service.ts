import { simpleGit, type SimpleGit, type FileStatusResult } from 'simple-git';
import type { GitStatusPayload, GitIsRepoPayload, GitFileStatus } from '../shared/ipc-api';

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

  async getFullStatus(cwd: string): Promise<GitStatusPayload> {
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

    try {
      const [branchInfo, statusResult] = await Promise.all([
        git.branch(),
        git.status(),
      ]);

      const branch = branchInfo.current;
      const untrackedPaths = new Set(statusResult.not_added);

      // Get numstat for tracked file stats
      let numstatRaw = '';
      const hasTrackedChanges = statusResult.files.some(
        (f) => !untrackedPaths.has(f.path),
      );
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
            deletions: parseInt(parts[1]) || 0,
          });
        }
      }

      // Build file list
      const files: GitFileStatus[] = statusResult.files.map((f) => {
        const isUntracked = untrackedPaths.has(f.path);
        const stats = numstatMap.get(f.path) || { insertions: 0, deletions: 0 };
        return {
          path: f.path,
          status: resolveStatus(f, isUntracked),
          insertions: stats.insertions,
          deletions: stats.deletions,
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
          const untrackedDiff = await git.raw([
            'diff',
            '--no-index',
            '/dev/null',
            path,
          ]);
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
}

function resolveStatus(
  file: FileStatusResult,
  isUntracked: boolean,
): GitFileStatus['status'] {
  if (isUntracked) return 'untracked';
  // Check both index and working_dir status
  const combined = file.index + file.working_dir;
  if (combined.includes('R')) return 'renamed';
  if (combined.includes('A')) return 'added';
  if (combined.includes('D')) return 'deleted';
  return 'modified';
}
