import { spawn, type ChildProcess, type StdioOptions } from 'child_process';
import type { PathContext } from '../shared/shell-profiles';
import { wslExePath } from './wsl-service';

/**
 * Tier-3 spawn boundary (see docs/wsl-path-handling-plan.md §8). Runs a Windows
 * CLI tool either natively or *inside* a WSL distro, keyed on the pane's
 * {@link PathContext}. For a WSL pane the tool runs in the distro via
 *
 *     wsl.exe -d <distro> [--cd <posixCwd>] --exec <cmd> <args...>
 *
 * so it sees the distro's own `git`/`rg`/`find` config and the repo's true
 * POSIX path — Windows `git.exe` against a UNC cwd is unreliable. `--exec`
 * passes argv verbatim with **no shell**: no pipes, globs or quoting. Anything
 * that needs a shell must invoke `sh -c` explicitly as the command.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// The only object variant of PathContext is the WSL one.
function isWslContext(ctx: PathContext): ctx is { kind: 'wsl'; distro: string } {
  return typeof ctx === 'object';
}

/**
 * Resolve the executable + argv to run `cmd args...` in the given context.
 * Pure — no spawning — so the WSL prefixing is unit-testable. For native
 * contexts the cwd is applied by the spawn options; for WSL it travels in the
 * `--cd` flag instead (the wsl.exe process itself can't chdir to a posix path).
 */
export function buildContextArgv(
  ctx: PathContext,
  cmd: string,
  args: string[],
  cwd?: string
): { file: string; argv: string[] } {
  if (isWslContext(ctx)) {
    const argv = ['-d', ctx.distro];
    if (cwd) argv.push('--cd', cwd);
    argv.push('--exec', cmd, ...args);
    return { file: wslExePath(), argv };
  }
  return { file: cmd, argv: args };
}

export interface SpawnInContextOptions {
  /** Working directory — a posix path for WSL, a native path otherwise. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Spawn `cmd args...` in the given context, returning the live ChildProcess. */
export function spawnInContext(
  ctx: PathContext,
  cmd: string,
  args: string[],
  opts: SpawnInContextOptions = {}
): ChildProcess {
  const { file, argv } = buildContextArgv(ctx, cmd, args, opts.cwd);
  // For WSL the cwd is carried by `--cd`; the wsl.exe process must not inherit
  // the posix cwd (it isn't a valid win32 directory and would fail to spawn).
  const spawnCwd = isWslContext(ctx) ? undefined : opts.cwd;
  return spawn(file, argv, {
    cwd: spawnCwd,
    env: opts.env,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe']
  });
}

export interface ExecInContextOptions extends SpawnInContextOptions {
  /** Kill the process after this many ms (a stopped distro can cold-boot). */
  timeoutMs?: number;
  /** Cap on buffered stdout bytes; excess is dropped. */
  maxBuffer?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run `cmd args...` to completion in the given context, buffering stdout/stderr.
 * Resolves with the exit code for any clean exit (never rejects on a non-zero
 * code — callers like `git diff --no-index` rely on that); rejects only when the
 * process fails to spawn.
 */
export async function execInContext(
  ctx: PathContext,
  cmd: string,
  args: string[],
  opts: ExecInContextOptions = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    const proc = spawnInContext(ctx, cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout?.on('data', (c: Buffer) => {
      outLen += c.length;
      if (outLen <= maxBuffer) outChunks.push(c);
    });
    proc.stderr?.on('data', (c: Buffer) => errChunks.push(c));

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        code,
        timedOut
      });
    });
  });
}
