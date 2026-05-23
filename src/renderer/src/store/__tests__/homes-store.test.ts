import { describe, it, expect, beforeEach, vi } from 'vitest';

const wslHomeDirMock = vi.fn();

beforeEach(() => {
  wslHomeDirMock.mockReset();
  (globalThis as unknown as { window: unknown }).window = {
    fleet: {
      homeDir: 'C:\\Users\\khang',
      wsl: { homeDir: wslHomeDirMock }
    }
  };
});

async function freshStore() {
  const mod = await import('../homes-store');
  mod.useHomesStore.setState({
    hostHomeDir: (globalThis as unknown as { window: { fleet: { homeDir: string } } }).window.fleet.homeDir,
    wslHomeByDistro: {}
  });
  return mod;
}

describe('useHomesStore', () => {
  it('exposes the host home dir from window.fleet.homeDir', async () => {
    const { useHomesStore } = await freshStore();
    expect(useHomesStore.getState().hostHomeDir).toBe('C:\\Users\\khang');
  });

  it('ensureWslHome() caches the result per distro', async () => {
    wslHomeDirMock.mockResolvedValueOnce('/home/khang');
    const { useHomesStore } = await freshStore();
    await useHomesStore.getState().ensureWslHome('Ubuntu');
    await useHomesStore.getState().ensureWslHome('Ubuntu');
    expect(wslHomeDirMock).toHaveBeenCalledTimes(1);
    expect(useHomesStore.getState().wslHomeByDistro.Ubuntu).toBe('/home/khang');
  });

  it('snapshot() returns the shape expected by path-platform.displayPath', async () => {
    wslHomeDirMock.mockResolvedValueOnce('/home/khang');
    const { useHomesStore } = await freshStore();
    await useHomesStore.getState().ensureWslHome('Ubuntu');
    const snap = useHomesStore.getState().snapshot();
    expect(snap).toEqual({
      homeDir: 'C:\\Users\\khang',
      wslHomeByDistro: { Ubuntu: '/home/khang' }
    });
  });
});
