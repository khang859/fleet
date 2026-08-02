// src/main/remote-ssh/remote-ssh-service.ts

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  RemoteDirEntry,
  RemoteFetchResult,
  RemoteHost,
  RemoteListResult,
  RemoteTextResult,
  RemoteTransferRequest
} from '../../shared/remote-ssh-types';
import { createLogger } from '../logger';
import {
  commitCached,
  ensureCacheDir,
  evictIfNeeded,
  invalidateCached,
  lookupCached,
  cachePathFor
} from './remote-cache';
import { closeConnection, testConnection } from './ssh-control';
import { listRemoteDir, statRemotePath, resolveRemotePath } from './ssh-listing';
import {
  fetchToCache,
  sftpMkdir,
  sftpRemoveFile,
  sftpRename,
  writeRemoteText
} from './ssh-transfer';
import { buildRecursiveDeletePlan, listRecursive } from './ssh-delete-plan';
import { TransferManager, type TransferEmit } from './transfer-manager';

const log = createLogger('remote-ssh:service');

/** Matches FileEditorPane's local cap, so remote and local behave the same. */
const MAX_TEXT_BYTES = 10 * 1024 * 1024;

function scratchDir(): string {
  return join(homedir(), '.fleet', 'remote-cache', '.scratch');
}

/**
 * Everything the IPC layer calls. Deliberately thin: each method composes the
 * listing / transfer / cache primitives and translates failures into plain
 * Error messages the handlers turn into `{success:false,error}`.
 */
export class RemoteSshService {
  private readonly transfers: TransferManager;

  /** `emitTransfer` forwards progress to the renderer; tests pass a no-op. */
  constructor(emitTransfer: TransferEmit = () => undefined) {
    this.transfers = new TransferManager(emitTransfer);
  }

  async test(host: RemoteHost): Promise<{ ok: true } | { ok: false; error: string }> {
    return testConnection(host);
  }

  async list(host: RemoteHost, path: string): Promise<RemoteListResult> {
    return listRemoteDir(host, path);
  }

  async stat(host: RemoteHost, path: string): Promise<RemoteDirEntry | null> {
    return statRemotePath(host, path);
  }

  async home(host: RemoteHost): Promise<string> {
    return resolveRemotePath(host, '~');
  }

  /**
   * Materialize a remote file into the local cache and return its local path.
   * This is what lets `fleet-image://` / `fleet-pdf://` and the four viewer
   * panes stay unchanged - they only ever see a local, `fs`-readable path.
   */
  async fetch(host: RemoteHost, remotePath: string): Promise<RemoteFetchResult> {
    const info = await statRemotePath(host, remotePath);
    if (!info) throw new Error('File not found on the remote host.');
    if (info.kind === 'dir') throw new Error('Path is a directory.');

    const cached = await lookupCached(host, remotePath, info.size, info.mtimeMs);
    if (cached) {
      return { localPath: cached, size: info.size, mtimeMs: info.mtimeMs };
    }

    await ensureCacheDir(host);
    const cachePath = cachePathFor(host, remotePath);
    await fetchToCache(host, remotePath, cachePath);
    await commitCached(host, remotePath, info.size, info.mtimeMs);
    // Opportunistic, not scheduled - no background sweeper to keep alive.
    void evictIfNeeded().catch((err) => log.debug('eviction failed', { err: String(err) }));

    return { localPath: cachePath, size: info.size, mtimeMs: info.mtimeMs };
  }

  async readText(host: RemoteHost, remotePath: string): Promise<RemoteTextResult> {
    const info = await statRemotePath(host, remotePath);
    if (!info) throw new Error('File not found on the remote host.');
    if (info.size > MAX_TEXT_BYTES) {
      throw new Error(
        `File is too large to open (${Math.round(info.size / 1024 / 1024)} MB, limit 10 MB).`
      );
    }
    const { localPath } = await this.fetch(host, remotePath);
    return {
      content: await readFile(localPath, 'utf-8'),
      size: info.size,
      mtimeMs: info.mtimeMs
    };
  }

  /**
   * Save text back. `expectedMtimeMs` guards against clobbering a change made
   * by someone else since the file was loaded - the same optimistic-concurrency
   * contract the Env Editor and Notes use locally.
   */
  async writeText(
    host: RemoteHost,
    remotePath: string,
    content: string,
    expectedMtimeMs?: number
  ): Promise<{ ok: true; mtimeMs: number } | { ok: false; externalChange: true }> {
    if (expectedMtimeMs !== undefined) {
      const current = await statRemotePath(host, remotePath);
      if (current && current.mtimeMs !== 0 && current.mtimeMs !== expectedMtimeMs) {
        return { ok: false, externalChange: true };
      }
    }

    await writeRemoteText(host, remotePath, content, scratchDir());
    await invalidateCached(host, remotePath);

    const after = await statRemotePath(host, remotePath);
    return { ok: true, mtimeMs: after?.mtimeMs ?? 0 };
  }

  /**
   * Byte transfers go through the manager rather than straight to sftp so they
   * report progress and can be cancelled. Both stage through a temp path, so a
   * cancelled transfer leaves neither a truncated download nor a half-written
   * remote file.
   */
  async download(request: RemoteTransferRequest): Promise<void> {
    await this.transfers.download(request);
  }

  async upload(request: RemoteTransferRequest): Promise<void> {
    await this.transfers.upload(request);
    await invalidateCached(request.host, request.remotePath);
  }

  cancelTransfer(id: string): void {
    this.transfers.cancel(id);
  }

  async mkdir(host: RemoteHost, remotePath: string): Promise<void> {
    await sftpMkdir(host, remotePath);
  }

  async rename(host: RemoteHost, from: string, to: string): Promise<void> {
    await sftpRename(host, from, to);
    await invalidateCached(host, from);
  }

  /**
   * Delete a file, or a directory and everything under it.
   *
   * There is no server-side trash: SFTP `rm` is permanent. The UI is responsible
   * for saying so plainly before calling this.
   */
  async remove(host: RemoteHost, remotePath: string, isDirectory: boolean): Promise<void> {
    if (!isDirectory) {
      await sftpRemoveFile(host, remotePath);
      await invalidateCached(host, remotePath);
      return;
    }
    const nodes = await listRecursive(host, remotePath);
    await buildRecursiveDeletePlan(host, nodes);
    await invalidateCached(host, remotePath);
  }

  async disconnect(host: RemoteHost): Promise<void> {
    await closeConnection(host);
  }
}
