// src/main/remote-ssh/transfer-manager.ts

import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  RemoteHost,
  RemoteTransfer,
  RemoteTransferDirection
} from '../../shared/remote-ssh-types';
import { createLogger } from '../logger';
import { statRemotePath } from './ssh-listing';
import { sftpGet, sftpPutAtomic, sftpRemoveFile, stagingPathFor } from './ssh-transfer';

const log = createLogger('remote-ssh:transfer');

/**
 * A local `.part` file is cheap to stat, so downloads sample often. Uploads have
 * to ask the remote, which costs a round trip on the multiplexed connection, so
 * they sample at a rate a human still reads as live but that stays negligible
 * next to the transfer itself.
 */
const LOCAL_POLL_MS = 250;
const REMOTE_POLL_MS = 1_000;

export type TransferEmit = (transfer: RemoteTransfer) => void;

type StartArgs = {
  id: string;
  paneId: string;
  host: RemoteHost;
  localPath: string;
  remotePath: string;
};

/**
 * Runs byte transfers and reports how far along they are.
 *
 * Progress is *observed*, not reported by `sftp`: its progress meter only prints
 * to a TTY and these spawns are headless. So each transfer stages through a temp
 * path and a timer stats that path, which is exact for downloads and one poll
 * behind for uploads. Both stage rather than writing the destination directly,
 * so cancelling or crashing mid-copy leaves no truncated file at either end.
 */
export class TransferManager {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly emit: TransferEmit) {}

  async download(args: StartArgs): Promise<void> {
    const { host, remotePath, localPath } = args;
    const info = await statRemotePath(host, remotePath);
    if (!info) throw new Error('File not found on the remote host.');
    if (info.kind === 'dir') throw new Error('Folders cannot be downloaded yet.');

    const partial = join(dirname(localPath), `.${basename(localPath)}.fleet-part`);
    await this.run({
      ...args,
      direction: 'download',
      name: basename(remotePath),
      total: info.size,
      sample: async () => sizeOfLocal(partial),
      transfer: async (signal) => {
        await sftpGet(host, remotePath, partial, { signal });
        await rename(partial, localPath);
      },
      discard: async () => rm(partial, { force: true })
    });
  }

  async upload(args: StartArgs): Promise<void> {
    const { host, remotePath, localPath } = args;
    const local = await stat(localPath).catch(() => null);
    if (!local) throw new Error('Local file not found.');

    const staging = stagingPathFor(remotePath);
    await this.run({
      ...args,
      direction: 'upload',
      name: basename(localPath),
      total: local.size,
      pollMs: REMOTE_POLL_MS,
      sample: async () => (await statRemotePath(host, staging))?.size ?? 0,
      transfer: async (signal) =>
        sftpPutAtomic(host, localPath, remotePath, { signal, stagingPath: staging }),
      discard: async () => sftpRemoveFile(host, staging)
    });
  }

  /** Idempotent: cancelling an unknown or already-finished id is a no-op. */
  cancel(id: string): void {
    this.running.get(id)?.abort();
  }

  private async run(
    job: StartArgs & {
      direction: RemoteTransferDirection;
      name: string;
      total: number;
      pollMs?: number;
      /** Bytes written so far, sampled from whichever end is being staged. */
      sample: () => Promise<number>;
      transfer: (signal: AbortSignal) => Promise<void>;
      /** Remove the staged partial file. Best-effort. */
      discard: () => Promise<void>;
    }
  ): Promise<void> {
    const controller = new AbortController();
    this.running.set(job.id, controller);

    let transferred = 0;
    const snapshot = (state: RemoteTransfer['state'], error?: string): RemoteTransfer => ({
      id: job.id,
      paneId: job.paneId,
      direction: job.direction,
      name: job.name,
      transferred,
      total: job.total,
      state,
      error
    });

    this.emit(snapshot('active'));
    const timer = setInterval(() => {
      void job
        .sample()
        .then((bytes) => {
          // Never let a sample walk backwards: a staged file can briefly vanish
          // between rename and stat, and a bar that jumps to 0 reads as a fault.
          if (bytes <= transferred) return;
          transferred = Math.min(bytes, job.total || bytes);
          this.emit(snapshot('active'));
        })
        .catch(() => undefined);
    }, job.pollMs ?? LOCAL_POLL_MS);

    try {
      await job.transfer(controller.signal);
      transferred = job.total;
      this.emit(snapshot('done'));
    } catch (err) {
      await job.discard().catch(() => undefined);
      if (controller.signal.aborted) {
        this.emit(snapshot('cancelled'));
        return;
      }
      const error = err instanceof Error ? err.message : String(err);
      log.debug('transfer failed', { id: job.id, direction: job.direction, error });
      this.emit(snapshot('error', error));
      throw err;
    } finally {
      clearInterval(timer);
      this.running.delete(job.id);
    }
  }
}

async function sizeOfLocal(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.size ?? 0;
}
