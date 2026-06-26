import { spawn } from 'child_process';

/** Secret-ish env vars scrubbed before spawning a child shell. */
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API|AUTH|PRIVATE)/i;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if the command was killed by the timeout. */
  timedOut: boolean;
  /** True if output was truncated to the cap. */
  truncated: boolean;
};

/** Strip likely-secret env vars so a child shell can't exfiltrate them. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Run a shell command, capturing stdout/stderr with a hard timeout and an
 * output cap. The command string is passed to the platform shell as-is — the
 * permission gate (deny → ask → allow over every parsed subcommand) is the
 * security boundary, not this function.
 */
export async function runBash(opts: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Stream stdout/stderr fragments to the renderer as they arrive. */
  onOutput?: (chunk: string) => void;
  /** Wrap argv with a sandbox (e.g. bubblewrap). Defaults to identity. */
  wrap?: (argv: string[]) => string[];
}): Promise<BashResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isWin = process.platform === 'win32';
  const baseArgv = isWin
    ? ['cmd.exe', '/d', '/s', '/c', opts.command]
    : ['/bin/bash', '-c', opts.command];
  const [cmd, ...args] = opts.wrap ? opts.wrap(baseArgv) : baseArgv;

  return new Promise<BashResult>((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: scrubEnv(process.env),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const append = (buf: Buffer, toStderr: boolean): void => {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      if (buf.length > remaining) truncated = true;
      bytes += slice.length;
      const text = slice.toString('utf8');
      if (toStderr) stderr += text;
      else stdout += text;
      opts.onOutput?.(text);
    };

    child.stdout.on('data', (b: Buffer) => append(b, false));
    child.stderr.on('data', (b: Buffer) => append(b, true));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = (): void => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr, exitCode, timedOut, truncated });
    };

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
