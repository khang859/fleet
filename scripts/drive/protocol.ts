import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { driveFilePath } from '../../src/shared/drive-session';
import { z } from 'zod';

/**
 * The client and the daemon speak newline-delimited JSON over a local socket:
 * one request line in, one response line out.
 *
 * `client.mts` restates these shapes rather than importing them - it runs on
 * bare Node, which cannot resolve this file's extensionless imports. Keep the
 * two in step.
 */
export const requestSchema = z.object({
  id: z.number(),
  verb: z.string(),
  args: z.array(z.string()),
  /** Where the client ran, so relative paths (`--out`, a `run` file) mean what the caller meant. */
  cwd: z.string(),
  /** The script for `run` when it came on stdin. */
  stdin: z.string().optional()
});

export type DriveRequest = z.infer<typeof requestSchema>;

export type DriveResponse =
  | { id: number; ok: true; output: string; warnings: string[] }
  | { id: number; ok: false; error: string }
  /** The daemon's own code changed on disk. It is exiting; start a fresh one and resend. */
  | { id: number; ok: false; restart: true };

/** Written by the daemon once it is listening; the client finds it through this. */
export interface DaemonInfo {
  pid: number;
  socket: string;
  startedAt: string;
}

export function daemonInfoPath(root: string): string {
  return driveFilePath(root, 'daemon.json');
}

/**
 * The socket lives outside the checkout: macOS caps a socket path at 104
 * bytes, and a worktree under `.claude/worktrees/` is already close to that.
 */
export function daemonSocketPath(root: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\fleet-drive-${hash}`
    : join(tmpdir(), `fleet-drive-${hash}.sock`);
}
