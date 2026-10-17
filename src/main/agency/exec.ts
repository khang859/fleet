import { execFile } from 'node:child_process';
import { enrichProcessEnv } from '../shell-env';

/** One timeout for every git call the agency makes. */
export const GIT_TIMEOUT_MS = 15_000;
/** `ls-tree` of a large monorepo runs to megabytes. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** A command's exit code and trimmed stdout, or null when it could not start. */
export type Captured = { code: number; stdout: string } | null;

/**
 * Run a tool the user installed and keep its exit code. Runs on the login-shell
 * PATH, so a Homebrew or npm-global install is found the way a terminal pane
 * would find it. `env` is added on top of the process environment.
 */
export async function runCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; env?: Record<string, string> }
): Promise<Captured> {
  await enrichProcessEnv();
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, env: { ...process.env, ...opts.env } },
      (err, stdout) => {
        if (err && typeof err.code !== 'number') {
          done(null);
          return;
        }
        done({ code: err ? Number(err.code) : 0, stdout: stdout.trim() });
      }
    );
  });
}

/**
 * Run `git <args>` in `cwd`; resolves with stdout exactly as git wrote it, or
 * null on any failure. Untrimmed, so a file read with `cat-file` keeps its last
 * newline.
 */
export async function gitExec(args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        done(err ? null : stdout);
      }
    );
  });
}
