import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { execFile } from 'node:child_process';
import { RuneManager } from '../rune-manager';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = execFile as unknown as Mock;

// Models a fake `rune` on PATH: the version probe reflects `currentVersion` (null = not installed),
// and running the install script flips `currentVersion` to `installSetsVersion` (or fails).
let currentVersion: string | null;
let installSetsVersion: string | null;
let installError: { stderr: string } | null;

beforeEach(() => {
  currentVersion = null;
  installSetsVersion = null;
  installError = null;

  execFileMock.mockReset();
  // Generic promisify(execFile) appends a (err, { stdout, stderr }) callback as the last arg.
  execFileMock.mockImplementation(
    (file: string, args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
      if (file === 'rune' && args[0] === '--version') {
        if (currentVersion === null) cb(new Error('command not found: rune'));
        else cb(null, { stdout: `rune ${currentVersion}\n`, stderr: '' });
        return;
      }
      if (file === 'sh') {
        if (installError) {
          cb(Object.assign(new Error('exited with code 1'), { stderr: installError.stderr }));
        } else {
          currentVersion = installSetsVersion;
          cb(null, { stdout: 'installed\n', stderr: '' });
        }
        return;
      }
      cb(new Error(`unexpected execFile: ${file} ${args.join(' ')}`));
    }
  );
});

describe('RuneManager.installOrUpdate', () => {
  it('reports a fresh install with no previous version', async () => {
    currentVersion = null;
    installSetsVersion = '1.2.0';
    const mgr = new RuneManager();

    const result = await mgr.installOrUpdate();

    expect(result).toEqual({
      previousVersion: null,
      status: { installed: true, version: '1.2.0' }
    });
    // The script ran through a shell because the install command is a pipe.
    expect(execFileMock).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.any(String)],
      expect.anything(),
      expect.any(Function)
    );
  });

  it('reports the version delta on update', async () => {
    currentVersion = '1.0.0';
    installSetsVersion = '1.1.0';
    const mgr = new RuneManager();

    const result = await mgr.installOrUpdate();

    expect(result).toEqual({
      previousVersion: '1.0.0',
      status: { installed: true, version: '1.1.0' }
    });
  });

  it('throws with the script stderr when the install fails', async () => {
    currentVersion = null;
    installError = { stderr: 'curl: (6) could not resolve host' };
    const mgr = new RuneManager();

    await expect(mgr.installOrUpdate()).rejects.toThrow('could not resolve host');
  });
});
