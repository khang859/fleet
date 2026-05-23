import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShellProfile } from '../../../../shared/shell-profiles';

const listMock = vi.fn();

beforeEach(() => {
  listMock.mockReset();
  // Stub the preload bridge before importing the store
  (
    globalThis as unknown as { window: { fleet: { shellProfiles: { list: typeof listMock } } } }
  ).window = {
    fleet: { shellProfiles: { list: listMock } }
  };
});

async function freshStore() {
  // Re-import to reset Zustand state between tests
  const mod = await import('../shell-profiles-store');
  mod.useShellProfilesStore.setState({ profiles: [], defaultProfile: null, isLoaded: false });
  return mod;
}

describe('useShellProfilesStore', () => {
  it('starts empty and isLoaded=false', async () => {
    const { useShellProfilesStore } = await freshStore();
    expect(useShellProfilesStore.getState().profiles).toEqual([]);
    expect(useShellProfilesStore.getState().defaultProfile).toBeNull();
    expect(useShellProfilesStore.getState().isLoaded).toBe(false);
  });

  it('load() populates profiles and defaultProfile by id', async () => {
    const profile: ShellProfile = {
      id: 'wsl.Ubuntu',
      kind: 'wsl',
      label: 'Ubuntu (WSL)',
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
      pathContext: { kind: 'wsl', distro: 'Ubuntu' }
    };
    const pwsh: ShellProfile = {
      id: 'windows.powershell',
      kind: 'system',
      label: 'PowerShell',
      command: 'powershell.exe',
      args: [],
      pathContext: 'win32'
    };
    listMock.mockResolvedValue({ profiles: [pwsh, profile], defaultProfileId: 'wsl.Ubuntu' });

    const { useShellProfilesStore } = await freshStore();
    await useShellProfilesStore.getState().load();

    const state = useShellProfilesStore.getState();
    expect(state.profiles).toHaveLength(2);
    expect(state.defaultProfile?.id).toBe('wsl.Ubuntu');
    expect(state.isLoaded).toBe(true);
  });

  it('falls back to first profile when defaultProfileId is not found', async () => {
    const pwsh: ShellProfile = {
      id: 'windows.powershell',
      kind: 'system',
      label: 'PowerShell',
      command: 'powershell.exe',
      args: [],
      pathContext: 'win32'
    };
    listMock.mockResolvedValue({ profiles: [pwsh], defaultProfileId: 'wsl.Missing' });

    const { useShellProfilesStore } = await freshStore();
    await useShellProfilesStore.getState().load();

    expect(useShellProfilesStore.getState().defaultProfile?.id).toBe('windows.powershell');
  });

  it('load() is idempotent — calling twice does not re-fetch', async () => {
    listMock.mockResolvedValue({ profiles: [], defaultProfileId: '' });
    const { useShellProfilesStore } = await freshStore();
    await useShellProfilesStore.getState().load();
    await useShellProfilesStore.getState().load();
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
