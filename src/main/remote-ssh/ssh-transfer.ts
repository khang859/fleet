// src/main/remote-ssh/ssh-transfer.ts

import { rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteHost } from '../../shared/remote-ssh-types';
import { execSftpBatch, type SshExecResult } from './ssh-control';
import { statRemotePath } from './ssh-listing';
import { sftpQuote } from './ssh-quote';

/**
 * Byte movement and mutations, all over SFTP.
 *
 * SFTP is used rather than `ssh cat`/`ssh rm` because no remote shell is
 * involved: paths travel as protocol strings, so a filename cannot be
 * interpreted as a command. That removes the injection class entirely for every
 * operation that touches file contents or mutates the remote filesystem, rather
 * than relying on quoting discipline at each call site.
 */

/** sftp reports failures on stderr while still sometimes exiting 0 on batch input. */
function assertSftpOk(result: SshExecResult, action: string): void {
  const stderr = result.stderr.trim();
  const failed = result.code !== 0 || /^(Couldn't|Cannot|remote |Failure)/im.test(stderr);
  if (!failed) return;

  const detail = stderr
    .split('\n')
    .filter((l) => l.trim() && !/^(Connected to|sftp>)/.test(l))
    .join('; ');
  throw new Error(detail || `${action} failed (sftp exit ${result.code})`);
}

/**
 * Transfers get an hour rather than the module default, because the ceiling has
 * to cover a large file over a slow link. A stalled connection is caught by
 * ssh's own keepalives, not by cutting a legitimately long copy short.
 */
const TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;

export type TransferOptions = { signal?: AbortSignal };

/** Download a remote file to a local path. */
export async function sftpGet(
  host: RemoteHost,
  remotePath: string,
  localPath: string,
  opts: TransferOptions = {}
): Promise<void> {
  const result = await execSftpBatch(
    host,
    [`get ${sftpQuote(remotePath)} ${sftpQuote(localPath)}`],
    { timeoutMs: TRANSFER_TIMEOUT_MS, signal: opts.signal }
  );
  assertSftpOk(result, 'Download');
}

/** Upload a local file to a remote path. */
export async function sftpPut(
  host: RemoteHost,
  localPath: string,
  remotePath: string,
  opts: TransferOptions = {}
): Promise<void> {
  const result = await execSftpBatch(
    host,
    [`put ${sftpQuote(localPath)} ${sftpQuote(remotePath)}`],
    { timeoutMs: TRANSFER_TIMEOUT_MS, signal: opts.signal }
  );
  assertSftpOk(result, 'Upload');
}

/**
 * Sibling name an atomic upload stages through. Exposed so a caller that wants
 * progress can stat the file actually being written, rather than the target
 * that only appears at the very end.
 */
export function stagingPathFor(remotePath: string): string {
  return `${remotePath}.fleet-tmp-${process.pid}-${Date.now()}`;
}

/**
 * Upload atomically: write to a sibling temp name, then rename over the target.
 * A crash or dropped connection mid-transfer leaves the original file intact
 * instead of truncated - the same guarantee `writeEnvFile` gives locally.
 */
export async function sftpPutAtomic(
  host: RemoteHost,
  localPath: string,
  remotePath: string,
  opts: TransferOptions & { stagingPath?: string } = {}
): Promise<void> {
  const tempRemote = opts.stagingPath ?? stagingPathFor(remotePath);
  await sftpPut(host, localPath, tempRemote, { signal: opts.signal });

  const rename = async (): Promise<SshExecResult> =>
    execSftpBatch(host, [`rename ${sftpQuote(tempRemote)} ${sftpQuote(remotePath)}`]);

  try {
    // OpenSSH servers advertise posix-rename@openssh.com, which the sftp client
    // uses automatically - so this single command atomically replaces the target
    // whether or not it already exists.
    assertSftpOk(await rename(), 'Save');
  } catch (err) {
    // A server without that extension refuses to rename onto an existing file.
    // Clear the target and retry, but only once the staged copy is confirmed
    // present, so a failure here can never leave the user holding neither file.
    const staged = await statRemotePath(host, tempRemote);
    if (!staged) throw err;
    // Discarded rather than checked: this `rm` is allowed to fail (the target
    // may simply not exist), and sftp writes that to stderr even when the
    // command is `-` prefixed, which is indistinguishable from a real failure.
    await execSftpBatch(host, [`-rm ${sftpQuote(remotePath)}`]).catch(() => undefined);
    try {
      assertSftpOk(await rename(), 'Save');
    } catch (retryErr) {
      await execSftpBatch(host, [`-rm ${sftpQuote(tempRemote)}`]).catch(() => undefined);
      throw retryErr;
    }
  }
}

export async function sftpMkdir(host: RemoteHost, remotePath: string): Promise<void> {
  assertSftpOk(await execSftpBatch(host, [`mkdir ${sftpQuote(remotePath)}`]), 'Create folder');
}

export async function sftpRename(host: RemoteHost, from: string, to: string): Promise<void> {
  assertSftpOk(await execSftpBatch(host, [`rename ${sftpQuote(from)} ${sftpQuote(to)}`]), 'Rename');
}

export async function sftpRemoveFile(host: RemoteHost, remotePath: string): Promise<void> {
  assertSftpOk(await execSftpBatch(host, [`rm ${sftpQuote(remotePath)}`]), 'Delete');
}

export async function sftpRemoveDir(host: RemoteHost, remotePath: string): Promise<void> {
  assertSftpOk(await execSftpBatch(host, [`rmdir ${sftpQuote(remotePath)}`]), 'Delete folder');
}

/** Run a prepared batch of rm/rmdir lines in one round trip. */
export async function sftpBatchRemove(host: RemoteHost, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  assertSftpOk(await execSftpBatch(host, lines, { timeoutMs: 120_000 }), 'Delete');
}

/** Write text to a remote file atomically, staging through a local temp file. */
export async function writeRemoteText(
  host: RemoteHost,
  remotePath: string,
  content: string,
  scratchDir: string
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const localTemp = join(scratchDir, `save-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(localTemp, content, 'utf-8');
    await sftpPutAtomic(host, localTemp, remotePath);
  } finally {
    await rm(localTemp, { force: true });
  }
}

/**
 * Fetch into the cache via a temp file then rename into place, so a failed or
 * partial transfer never leaves a truncated file that a later freshness check
 * would happily serve.
 */
export async function fetchToCache(
  host: RemoteHost,
  remotePath: string,
  cachePath: string
): Promise<void> {
  const tempLocal = join(dirname(cachePath), `.fetch-${process.pid}-${Date.now()}.part`);
  try {
    await sftpGet(host, remotePath, tempLocal);
    await rename(tempLocal, cachePath);
  } catch (err) {
    await rm(tempLocal, { force: true });
    throw err;
  }
}
