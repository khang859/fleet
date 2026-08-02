// src/main/remote-ssh/ssh-control.ts

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteHost } from '../../shared/remote-ssh-types';
import { createLogger } from '../logger';

const log = createLogger('remote-ssh:control');

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
/** How long a master socket outlives its last use, so reopening a pane is cheap. */
const CONTROL_PERSIST = '10m';

export type SshExecResult = {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

export type SshExecOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
  /** Written to the child's stdin, then closed. Used for `sftp -b -` batches. */
  stdin?: string;
  /**
   * Aborting kills the child. A half-written transfer is left behind on purpose:
   * callers stage into a temp path and clean up, so cancellation can never
   * truncate the real file at either end.
   */
  signal?: AbortSignal;
};

/** Stable identity for a host: what distinguishes one ssh connection from another. */
export function hostKey(host: RemoteHost): string {
  return `${host.user ?? ''}@${host.host}:${host.port ?? 22}`;
}

/** The ssh destination argument, e.g. `knguyen@khang-linux.example.net`. */
export function sshDestination(host: RemoteHost): string {
  return host.user ? `${host.user}@${host.host}` : host.host;
}

/**
 * Control socket path. The destination is **hashed** rather than embedded:
 * AF_UNIX paths are capped near 104 bytes on macOS/BSD, and a long tailnet
 * hostname plus a `~/.fleet/ssh-control/` prefix easily exceeds that.
 */
export function controlPathFor(host: RemoteHost): string {
  const digest = createHash('sha256').update(hostKey(host)).digest('hex').slice(0, 32);
  return join(controlDir(), `${digest}.sock`);
}

function controlDir(): string {
  const dir = join(homedir(), '.fleet', 'ssh-control');
  // 0700: anything able to connect to a master socket rides the authenticated
  // tunnel, so the directory must not be group/world accessible.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Options every ssh/sftp invocation shares.
 *
 * `BatchMode=yes` is load-bearing: these are headless spawns with no terminal to
 * answer a password or host-key prompt on, so a prompt would hang forever.
 * Batch mode turns that into a fast, reportable failure instead. Host key
 * verification is *not* disabled - an unknown host still fails, and the user
 * accepts it the way they normally would, in a terminal.
 */
function sharedOptions(host: RemoteHost): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPathFor(host)}`,
    '-o',
    `ControlPersist=${CONTROL_PERSIST}`
  ];
  if (host.port) args.push('-o', `Port=${host.port}`);
  if (host.identityFile) args.push('-o', `IdentityFile=${host.identityFile}`);
  return args;
}

/** argv for `ssh <shared opts> <destination> <remoteCommand>`. Pure, testable. */
export function buildSshArgv(host: RemoteHost, remoteCommand: string): string[] {
  return [...sharedOptions(host), sshDestination(host), remoteCommand];
}

/** argv for `sftp -b - <shared opts> <destination>`. Pure, testable. */
export function buildSftpArgv(host: RemoteHost): string[] {
  return ['-b', '-', ...sharedOptions(host), sshDestination(host)];
}

async function run(file: string, argv: string[], opts: SshExecOptions): Promise<SshExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    const proc = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'] });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    const onAbort = (): void => {
      proc.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    proc.stdout.on('data', (c: Buffer) => {
      outLen += c.length;
      if (outLen <= maxBuffer) outChunks.push(c);
    });
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        code,
        timedOut
      });
    });

    // stdin is always closed - an ssh that somehow still wants input must not hang.
    if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
    proc.stdin.end();
  });
}

/**
 * Run a command on the remote via ssh. Resolves for any clean exit including a
 * non-zero code (callers inspect `code`), matching `execInContext`'s contract;
 * rejects only when the local `ssh` binary fails to spawn.
 *
 * `remoteCommand` is interpreted by the remote login shell, so every dynamic
 * path inside it must already be `posixShellQuote`d by the caller.
 */
export async function execSsh(
  host: RemoteHost,
  remoteCommand: string,
  opts: SshExecOptions = {}
): Promise<SshExecResult> {
  const result = await run('ssh', buildSshArgv(host, remoteCommand), opts);
  if (result.code !== 0) {
    log.debug('execSsh non-zero exit', {
      host: hostKey(host),
      code: result.code,
      stderr: result.stderr.slice(0, 500)
    });
  }
  return result;
}

/** Run a batch of sftp commands over the same multiplexed connection. */
export async function execSftpBatch(
  host: RemoteHost,
  lines: string[],
  opts: SshExecOptions = {}
): Promise<SshExecResult> {
  const result = await run('sftp', buildSftpArgv(host), {
    ...opts,
    stdin: `${lines.join('\n')}\n`
  });
  if (result.code !== 0) {
    log.debug('execSftpBatch non-zero exit', {
      host: hostKey(host),
      code: result.code,
      stderr: result.stderr.slice(0, 500)
    });
  }
  return result;
}

/** Cheap liveness check used by the pane's connection indicator. */
export async function testConnection(
  host: RemoteHost
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await execSsh(host, 'true', { timeoutMs: 15_000 });
    if (result.code === 0) return { ok: true };
    return { ok: false, error: describeSshFailure(result) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Turn ssh's stderr into something worth showing a user. Host-key and auth
 * failures get an actionable hint pointing at the terminal Fleet already ships,
 * rather than Fleet re-implementing a trust-on-first-use dialog.
 */
export function describeSshFailure(result: SshExecResult): string {
  const stderr = result.stderr.trim();
  if (result.timedOut) return 'Connection timed out.';
  if (/host key verification failed/i.test(stderr)) {
    return 'Host key verification failed. Open a terminal pane, run `ssh <host>` once to review and accept the key, then retry.';
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return 'The remote host key has changed, which can indicate a man-in-the-middle attack. Verify the host before continuing.';
  }
  if (/permission denied/i.test(stderr)) {
    return 'Authentication failed. Fleet uses your existing SSH keys and agent - confirm `ssh <host>` works in a terminal.';
  }
  if (/could not resolve hostname|name or service not known/i.test(stderr)) {
    return 'Could not resolve the hostname.';
  }
  if (/connection refused/i.test(stderr)) return 'Connection refused.';
  return stderr || `ssh exited with code ${result.code}`;
}

/** Tear down a host's master connection. Safe to call when none exists. */
export async function closeConnection(host: RemoteHost): Promise<void> {
  try {
    await run(
      'ssh',
      ['-O', 'exit', '-o', `ControlPath=${controlPathFor(host)}`, sshDestination(host)],
      {
        timeoutMs: 5_000
      }
    );
  } catch {
    // Nothing to close, or ssh is unavailable - either way there's no cleanup left.
  }
}
