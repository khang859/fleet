import { spawn } from 'child_process';
import type { GitSummary } from '../../shared/claude-sessions';

export type GitResult = { stdout: string; truncated: boolean };

/** Runs git with a fixed argv in a folder. Rejects when git fails or times out. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

export const GIT_TIMEOUT_MS = 5_000;
export const GIT_OUTPUT_CAP = 1024 * 1024;

/**
 * A repository's own config can name an fsmonitor program that `status` runs.
 * Fleet only reads, so it turns that off; `diff` callers pass `--no-ext-diff`
 * and `--no-textconv` for the same reason.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false'];

/**
 * Run git without a shell, with a timeout and a cap on how much output is kept.
 * Output past the cap is dropped and the process is stopped.
 */
export function createGitRunner(opts: { timeoutMs?: number; maxBytes?: number } = {}): GitRunner {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? GIT_OUTPUT_CAP;
  return async (cwd, args) =>
    new Promise<GitResult>((resolve, reject) => {
      const child = spawn('git', [...SAFE_CONFIG, ...args], {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`git ${args[0]} timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(chunks).toString();
        if (truncated) resolve({ stdout, truncated });
        else if (code === 0) resolve({ stdout, truncated: false });
        else reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`));
      });
    });
}

/** `## main...origin/main [ahead 1]`, `## HEAD (no branch)` or `## No commits yet on main`. */
function branchFromHeader(header: string): string | null {
  const text = header.replace(/^## /, '');
  const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(text);
  if (unborn) return unborn[1];
  if (text.startsWith('HEAD (no branch)')) return null;
  return text.split('...')[0].split(' ')[0] || null;
}

function parseShortstat(text: string): { insertions: number; deletions: number } {
  const insertions = /(\d+) insertions?\(\+\)/.exec(text);
  const deletions = /(\d+) deletions?\(-\)/.exec(text);
  return {
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0
  };
}

/**
 * Summarize a folder's git state: branch, number of dirty files, and the diff
 * size against HEAD. Null when the folder is not in a git repository or git
 * could not be run.
 */
export async function probeGit(cwd: string, run: GitRunner): Promise<GitSummary | null> {
  let status: GitResult;
  try {
    status = await run(cwd, ['status', '--porcelain=v1', '--branch', '-z']);
  } catch {
    return null;
  }
  // -z ends every entry with NUL; a rename adds its old path as one more entry.
  const entries = status.stdout.split('\0').filter(Boolean);
  const header = entries[0]?.startsWith('## ') ? entries.shift() : undefined;
  let dirtyFiles = 0;
  for (let i = 0; i < entries.length; i++) {
    dirtyFiles++;
    if (/^[RC]/.test(entries[i])) i++;
  }

  let branch = header ? branchFromHeader(header) : null;
  if (!branch) {
    try {
      branch = (await run(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim() || 'HEAD';
    } catch {
      branch = 'HEAD';
    }
  }

  let stat = { insertions: 0, deletions: 0 };
  try {
    const diff = await run(cwd, ['diff', 'HEAD', '--shortstat', '--no-ext-diff', '--no-textconv']);
    stat = parseShortstat(diff.stdout);
  } catch {
    // No commits yet: nothing to diff against.
  }

  return { branch, dirtyFiles, ...stat, truncated: status.truncated };
}
