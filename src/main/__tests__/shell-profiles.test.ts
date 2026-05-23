import { describe, it, expect, vi } from 'vitest';
import { ShellProfileRegistry } from '../shell-profiles';
import type { WslService } from '../wsl-service';

function fakeWsl(distros: Array<{ name: string; isDefault?: boolean }>): Partial<WslService> {
  return {
    listDistros: vi.fn().mockResolvedValue(
      distros.map((d) => ({
        name: d.name,
        version: 2 as const,
        isDefault: !!d.isDefault,
        state: 'stopped' as const
      }))
    )
  };
}

describe('ShellProfileRegistry', () => {
  it('emits a single posix profile from SHELL on darwin', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      wslService: fakeWsl([]) as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    const profiles = await reg.enumerate();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: 'posix.zsh',
      kind: 'system',
      command: '/bin/zsh',
      pathContext: 'posix'
    });
  });

  it('emits PowerShell, cmd, and one profile per WSL distro on win32', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: fakeWsl([
        { name: 'Ubuntu-22.04', isDefault: true },
        { name: 'Debian' }
      ]) as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    const profiles = await reg.enumerate();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('windows.powershell');
    expect(ids).toContain('windows.cmd');
    expect(ids).toContain('wsl.Ubuntu-22.04');
    expect(ids).toContain('wsl.Debian');

    const ubuntu = profiles.find((p) => p.id === 'wsl.Ubuntu-22.04')!;
    expect(ubuntu.pathContext).toEqual({ kind: 'wsl', distro: 'Ubuntu-22.04' });
    expect(ubuntu.command).toBe('wsl.exe');
    expect(ubuntu.args).toEqual(['-d', 'Ubuntu-22.04']);
  });

  it('includes Git Bash on win32 only when the binary is present', async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => p.includes('Git\\bin\\bash.exe'));
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      wslService: fakeWsl([]) as WslService,
      fileExists
    });
    const profiles = await reg.enumerate();
    expect(profiles.some((p) => p.id === 'windows.git-bash')).toBe(true);
  });

  it('does not include Git Bash when the binary is absent', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      wslService: fakeWsl([]) as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    const profiles = await reg.enumerate();
    expect(profiles.some((p) => p.id === 'windows.git-bash')).toBe(false);
  });
});
