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

describe('ShellProfileRegistry caching', () => {
  it('only enumerates once across multiple calls', async () => {
    const listDistros = vi.fn().mockResolvedValue([]);
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: { listDistros } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    await reg.enumerate();
    await reg.enumerate();
    await reg.enumerate();
    expect(listDistros).toHaveBeenCalledTimes(1);
  });

  it('refresh() invalidates the cache', async () => {
    const listDistros = vi.fn().mockResolvedValue([]);
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: { listDistros } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    await reg.enumerate();
    reg.refresh();
    await reg.enumerate();
    expect(listDistros).toHaveBeenCalledTimes(2);
  });
});

describe('ShellProfileRegistry.getDefaultProfileId', () => {
  it('returns the first profile id on darwin', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      wslService: { listDistros: vi.fn().mockResolvedValue([]) } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('posix.zsh');
  });

  it('returns wsl.<default distro> on win32 when a default WSL distro exists', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: {
        listDistros: vi.fn().mockResolvedValue([
          { name: 'Debian', version: 2, isDefault: false, state: 'stopped' },
          { name: 'Ubuntu-22.04', version: 2, isDefault: true, state: 'running' }
        ])
      } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('wsl.Ubuntu-22.04');
  });

  it('returns windows.powershell on win32 when no WSL distros exist', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: { listDistros: vi.fn().mockResolvedValue([]) } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('windows.powershell');
  });

  it('returns the first WSL profile on win32 when WSL distros exist but none are default', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: {
        listDistros: vi.fn().mockResolvedValue([
          { name: 'Alpine', version: 2, isDefault: false, state: 'stopped' }
        ])
      } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('wsl.Alpine');
  });
});
