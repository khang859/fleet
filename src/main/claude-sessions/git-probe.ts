import { spawn } from 'child_process';
import type { GitSummary } from '../../shared/claude-sessions';

export type GitResult = { stdout: string; truncated: boolean };

/** Runs git with a fixed argv in a folder. Rejects when git fails or times out. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

export const GIT_TIMEOUT_MS = 5_000;
export const GIT_OUTPUT_CAP = 1024 * 1024;

/**
 * A repository's own config can name programs that reading runs: an fsmonitor
 * that `status` starts, and a gpg that `log` starts for a signed commit when
 * `log.showSignature` is on. Fleet only reads, so it turns both off; `diff`
 * callers pass `--no-ext-diff` and `--no-textconv` for the same reason.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];

/**
 * Commands that look into submodules, where each submodule's own config and
 * filters apply. A submodule's `submodule.<name>.ignore` beats the config
 * setting, so the flag is passed on the command line.
 */
const NO_SUBMODULES = new Set(['status', 'diff']);

const FILTER_KEYS = ['clean', 'smudge', 'process'];

type Spawned = { stdout: string; truncated: boolean; code: number | null; stderr: string };

async function spawnGit(
  name: string,
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBytes: number
): Promise<Spawned> {
  return new Promise<Spawned>((resolve, reject) => {
    const child = spawn('git', argv, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${name} timed out after ${timeoutMs} ms`));
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
      resolve({ stdout: Buffer.concat(chunks).toString(), truncated, code, stderr });
    });
  });
}

/**
 * Config that blanks every filter driver the repository's config names. A
 * `.gitattributes` can route any path through a driver, and `status` and
 * `diff` run its clean command. The pairs go through `GIT_CONFIG_KEY_n` rather
 * than `-c`, which splits at the first `=`, and a driver name may hold one.
 */
function blankFilters(listing: string): Record<string, string> {
  const names = new Set<string>();
  for (const key of listing.split('\0')) {
    const name = /^filter\.(.+)\.[^.]+$/s.exec(key)?.[1];
    if (name !== undefined) names.add(name);
  }
  const pairs: Array<[string, string]> = [];
  for (const name of names) {
    for (const key of FILTER_KEYS) pairs.push([`filter.${name}.${key}`, '']);
    pairs.push([`filter.${name}.required`, 'false']);
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Run git without a shell, with a timeout and a cap on how much output is kept.
 * Output past the cap is dropped and the process is stopped. Programs the
 * repository's config names are turned off first: see `SAFE_CONFIG`,
 * `NO_SUBMODULES` and `blankFilters`.
 */
export function createGitRunner(opts: { timeoutMs?: number; maxBytes?: number } = {}): GitRunner {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? GIT_OUTPUT_CAP;
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    GIT_CONFIG_COUNT: '0'
  };
  return async (cwd, args) => {
    const listing = await spawnGit(
      'config',
      cwd,
      ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'],
      base,
      timeoutMs,
      maxBytes
    );
    // 1 is "no such key"; anything else is left for the command itself to report.
    const filters = listing.code === 0 ? blankFilters(listing.stdout) : {};
    const [command, ...rest] = args;
    const argv = [
      ...SAFE_CONFIG,
      command,
      ...(NO_SUBMODULES.has(command) ? ['--ignore-submodules=all'] : []),
      ...rest
    ];
    const out = await spawnGit(command, cwd, argv, { ...base, ...filters }, timeoutMs, maxBytes);
    if (out.truncated) return { stdout: out.stdout, truncated: true };
    if (out.code === 0) return { stdout: out.stdout, truncated: false };
    throw new Error(`git ${command} exited ${out.code}: ${out.stderr.trim()}`);
  };
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
