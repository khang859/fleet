// src/main/remote-ssh/ipc-handlers.ts

import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  RemoteHost,
  RemoteResult,
  RemoteTransferRequest
} from '../../shared/remote-ssh-types';
import type { PtyManager } from '../pty-manager';
import { createLogger } from '../logger';
import { RemoteSshService } from './remote-ssh-service';
import { detectSshHost, type DetectedHost } from './ssh-host-detect';

const log = createLogger('remote-ssh:ipc');

/**
 * Wrap a service call in the `{success,data}|{success,error}` shape used across
 * Fleet's IPC surface. Nothing throws across the bridge: a dropped connection or
 * a permission error becomes a message the pane renders inline.
 */
async function guard<T>(action: string, fn: () => Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { success: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.debug(`${action} failed`, { error });
    return { success: false, error };
  }
}

export function registerRemoteSshIpcHandlers(ptyManager: PtyManager): RemoteSshService {
  // Progress is broadcast to every window rather than replied to the caller: the
  // renderer correlates by the transfer id it generated, and a transfer outlives
  // the single `invoke` that started it.
  const service = new RemoteSshService((transfer) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.REMOTE_SSH_TRANSFER_PROGRESS, transfer);
    }
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_TEST, async (_e, host: RemoteHost) =>
    guard('test', async () => service.test(host))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_HOME, async (_e, host: RemoteHost) =>
    guard('home', async () => service.home(host))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_LIST, async (_e, host: RemoteHost, path: string) =>
    guard('list', async () => service.list(host, path))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_STAT, async (_e, host: RemoteHost, path: string) =>
    guard('stat', async () => service.stat(host, path))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_FETCH, async (_e, host: RemoteHost, path: string) =>
    guard('fetch', async () => service.fetch(host, path))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_READ_TEXT, async (_e, host: RemoteHost, path: string) =>
    guard('readText', async () => service.readText(host, path))
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_SSH_WRITE_TEXT,
    async (_e, host: RemoteHost, path: string, content: string, expectedMtimeMs?: number) =>
      guard('writeText', async () => service.writeText(host, path, content, expectedMtimeMs))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_MKDIR, async (_e, host: RemoteHost, path: string) =>
    guard('mkdir', async () => service.mkdir(host, path))
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_SSH_RENAME,
    async (_e, host: RemoteHost, from: string, to: string) =>
      guard('rename', async () => service.rename(host, from, to))
  );

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_SSH_REMOVE,
    async (_e, host: RemoteHost, path: string, isDirectory: boolean) =>
      guard('remove', async () => service.remove(host, path, isDirectory))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_UPLOAD, async (_e, request: RemoteTransferRequest) =>
    guard('upload', async () => service.upload(request))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_DOWNLOAD, async (_e, request: RemoteTransferRequest) =>
    guard('download', async () => service.download(request))
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_TRANSFER_CANCEL, (_e, id: string) => {
    service.cancelTransfer(id);
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_DISCONNECT, async (_e, host: RemoteHost) =>
    guard('disconnect', async () => service.disconnect(host))
  );

  // Best-effort host discovery from a pane already SSH'd in. Returns null rather
  // than an error when nothing is found - the UI falls back to saved hosts.
  ipcMain.handle(IPC_CHANNELS.REMOTE_SSH_DETECT_HOST, async (_e, paneId: string) =>
    guard<DetectedHost | null>('detectHost', async () => {
      const pid = ptyManager.getPid(paneId);
      if (pid === undefined) return null;
      return detectSshHost(pid);
    })
  );

  return service;
}
