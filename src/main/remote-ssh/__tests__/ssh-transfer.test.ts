import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshExecResult } from '../ssh-control';
import type { RemoteHost } from '../../../shared/remote-ssh-types';

const mocks = vi.hoisted(() => ({
  execSftpBatch: vi.fn(),
  statRemotePath: vi.fn()
}));

vi.mock('../ssh-control', () => ({ execSftpBatch: mocks.execSftpBatch }));
vi.mock('../ssh-listing', () => ({ statRemotePath: mocks.statRemotePath }));

const { sftpPutAtomic } = await import('../ssh-transfer');

const HOST: RemoteHost = { id: 'h', label: 'box', host: 'box.example.net', user: 'k' };

function ok(): SshExecResult {
  return { stdout: Buffer.alloc(0), stderr: '', code: 0, timedOut: false };
}

function fail(stderr: string): SshExecResult {
  return { stdout: Buffer.alloc(0), stderr, code: 1, timedOut: false };
}

/** The sftp command lines each call was handed, in order. */
function issued(): string[][] {
  return mocks.execSftpBatch.mock.calls.map((call) => call[1] as string[]);
}

describe('sftpPutAtomic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads to a temp name and renames over the target in one step', async () => {
    mocks.execSftpBatch.mockResolvedValue(ok());

    await sftpPutAtomic(HOST, '/local/a.bin', '/remote/a.bin');

    const commands = issued();
    expect(commands).toHaveLength(2);
    expect(commands[0][0]).toMatch(/^put "\/local\/a\.bin" "\/remote\/a\.bin\.fleet-tmp-/);
    expect(commands[1][0]).toMatch(/^rename "\/remote\/a\.bin\.fleet-tmp-.*" "\/remote\/a\.bin"$/);
    // posix-rename@openssh.com replaces the target, so nothing is deleted first:
    // an unlink-then-rename would leave the user with neither file if it died
    // in between, and the earlier `-rm` also polluted stderr on a fresh upload.
    expect(commands.flat().join(' ')).not.toContain('rm ');
  });

  it('does not surface a tolerated rm failure when falling back', async () => {
    // Server without posix-rename: the first rename refuses to clobber, the
    // `-rm` that clears the way reports "No such file" on stderr, and the retry
    // succeeds. Only the retry decides the outcome.
    mocks.execSftpBatch
      .mockResolvedValueOnce(ok()) // put
      .mockResolvedValueOnce(fail('remote rename: File exists'))
      .mockResolvedValueOnce(fail('remote delete /remote/a.bin: No such file or directory'))
      .mockResolvedValueOnce(ok()); // retried rename
    mocks.statRemotePath.mockResolvedValue({
      name: 'a.bin',
      path: '/remote/a.bin',
      kind: 'file',
      size: 10,
      mtimeMs: 1
    });

    await expect(sftpPutAtomic(HOST, '/local/a.bin', '/remote/a.bin')).resolves.toBeUndefined();

    const commands = issued();
    expect(commands).toHaveLength(4);
    expect(commands[2][0]).toBe('-rm "/remote/a.bin"');
    expect(commands[3][0]).toMatch(/^rename /);
  });

  it('never clears the target when the staged copy has gone missing', async () => {
    mocks.execSftpBatch
      .mockResolvedValueOnce(ok()) // put
      .mockResolvedValueOnce(fail('remote rename: Permission denied'));
    mocks.statRemotePath.mockResolvedValue(null);

    await expect(sftpPutAtomic(HOST, '/local/a.bin', '/remote/a.bin')).rejects.toThrow(
      /Permission denied/
    );

    // Two calls only: the user still has whatever was there before.
    expect(issued()).toHaveLength(2);
  });

  it('cleans up the staged file when even the retry fails', async () => {
    mocks.execSftpBatch
      .mockResolvedValueOnce(ok()) // put
      .mockResolvedValueOnce(fail('remote rename: File exists'))
      .mockResolvedValueOnce(ok()) // -rm target
      .mockResolvedValueOnce(fail('remote rename: Permission denied'))
      .mockResolvedValueOnce(ok()); // -rm staged
    mocks.statRemotePath.mockResolvedValue({
      name: 'a.bin',
      path: '/remote/a.bin',
      kind: 'file',
      size: 10,
      mtimeMs: 1
    });

    await expect(sftpPutAtomic(HOST, '/local/a.bin', '/remote/a.bin')).rejects.toThrow(
      /Permission denied/
    );

    const last = issued().at(-1);
    expect(last?.[0]).toMatch(/^-rm "\/remote\/a\.bin\.fleet-tmp-/);
  });

  it('reports the sftp error rather than a bare exit code', async () => {
    mocks.execSftpBatch.mockResolvedValueOnce(
      fail('Couldn\'t write to remote file "/remote/a.bin": Permission denied')
    );

    await expect(sftpPutAtomic(HOST, '/local/a.bin', '/remote/a.bin')).rejects.toThrow(
      /Permission denied/
    );
  });
});
