import { create } from 'zustand';

type HomesState = {
  hostHomeDir: string;
  wslHomeByDistro: Record<string, string>;
  ensureWslHome: (distro: string) => Promise<string>;
  snapshot: () => { homeDir: string; wslHomeByDistro: Record<string, string> };
};

export const useHomesStore = create<HomesState>((set, get) => ({
  hostHomeDir: window.fleet.homeDir,
  wslHomeByDistro: {},
  ensureWslHome: async (distro: string) => {
    const cached = get().wslHomeByDistro[distro];
    if (cached) return cached;
    const home = await window.fleet.wsl.homeDir(distro);
    set((state) => ({
      wslHomeByDistro: { ...state.wslHomeByDistro, [distro]: home }
    }));
    return home;
  },
  snapshot: () => ({
    homeDir: get().hostHomeDir,
    wslHomeByDistro: get().wslHomeByDistro
  })
}));
