import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RemoteHost, RemoteTransfer } from '../../../shared/remote-ssh-types';

const mocks = vi.hoisted(() => ({
  statRemotePath: vi.fn(),
  sftpGet: vi.fn(),
  sftpPutAtomic: vi.fn(),
  sftpRemoveFile: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn()
}));

vi.mock('../ssh-listing', () => ({ statRemotePath: mocks.statRemotePath }));
vi.mock('../ssh-transfer', () => ({
  sftpGet: mocks.sftpGet,
  sftpPutAtomic: mocks.sftpPutAtomic,
  sftpRemoveFile: mocks.sftpRemoveFile,
  stagingPathFor: (remotePath: string) => `${remotePath}.staged`
}));
vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
  rename: mocks.rename,
  rm: mocks.rm
}));

const { TransferManager } = await import('../transfer-manager');

const HOST: RemoteHost = { id: 'h', label: 'box', host: 'box.example.net', user: 'k' };
const ARGS = {
  id: 't1',
  paneId: 'p1',
  host: HOST,
  localPath: '/local/a.bin',
  remotePath: '/remote/a.bin'
};

function remoteFile(size: number): {
  name: string;
  path: string;
  kind: 'file';
  size: number;
  mtimeMs: number;
} {
  return { name: 'a.bin', path: '/remote/a.bin', kind: 'file', size, mtimeMs: 1 };
}

describe('TransferManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('samples the staged file and never lets progress walk backwards', async () => {
    vi.useFakeTimers();
    mocks.stat.mockResolvedValue({ size: 100 });
    // A staged file can briefly appear smaller (or vanish) between samples; the
    // middle reading here is the one a naive implementation would show.
    mocks.statRemotePath
      .mockResolvedValueOnce(remoteFile(50))
      .mockResolvedValueOnce(remoteFile(20))
      .mockResolvedValue(remoteFile(80));

    let finish = (): void => undefined;
    mocks.sftpPutAtomic.mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    const emitted: RemoteTransfer[] = [];
    const manager = new TransferManager((t) => emitted.push({ ...t }));
    const done = manager.upload(ARGS);

    await vi.advanceTimersByTimeAsync(3_500);
    finish();
    await done;

    const progress = emitted.map((t) => t.transferred);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toContain(50);
    expect(progress).not.toContain(20);
    expect(emitted.at(-1)).toMatchObject({ state: 'done', transferred: 100, total: 100 });
  });

  it('reports a cancelled transfer without throwing, and clears the staged file', async () => {
    mocks.stat.mockResolvedValue({ size: 100 });
    mocks.statRemotePath.mockResolvedValue(remoteFile(0));
    mocks.sftpPutAtomic.mockImplementation(
      async (_h: RemoteHost, _l: string, _r: string, opts: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('killed')), { once: true });
        })
    );

    const emitted: RemoteTransfer[] = [];
    const manager = new TransferManager((t) => emitted.push({ ...t }));
    const done = manager.upload(ARGS);

    await vi.waitFor(() => expect(mocks.sftpPutAtomic).toHaveBeenCalled());
    manager.cancel('t1');

    // Cancelling is a normal outcome, not a failure the caller has to catch.
    await expect(done).resolves.toBeUndefined();
    expect(emitted.at(-1)).toMatchObject({ state: 'cancelled' });
    expect(mocks.sftpRemoveFile).toHaveBeenCalledWith(HOST, '/remote/a.bin.staged');
  });

  it('refuses to download a directory before starting any transfer', async () => {
    mocks.statRemotePath.mockResolvedValue({
      name: 'dir',
      path: '/remote/dir',
      kind: 'dir',
      size: 4096,
      mtimeMs: 1
    });

    const manager = new TransferManager(() => undefined);
    await expect(manager.download({ ...ARGS, remotePath: '/remote/dir' })).rejects.toThrow(
      /Folders/
    );
    expect(mocks.sftpGet).not.toHaveBeenCalled();
  });

  it('surfaces a failed transfer as an error snapshot and rethrows', async () => {
    mocks.stat.mockResolvedValue({ size: 100 });
    mocks.statRemotePath.mockResolvedValue(remoteFile(0));
    mocks.sftpPutAtomic.mockRejectedValue(new Error('Permission denied'));

    const emitted: RemoteTransfer[] = [];
    const manager = new TransferManager((t) => emitted.push({ ...t }));

    await expect(manager.upload(ARGS)).rejects.toThrow(/Permission denied/);
    expect(emitted.at(-1)).toMatchObject({ state: 'error', error: 'Permission denied' });
  });
});
