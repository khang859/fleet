import { create } from 'zustand';
import type { ShellProfile } from '../../../shared/shell-profiles';

type ShellProfilesState = {
  profiles: ShellProfile[];
  defaultProfile: ShellProfile | null;
  isLoaded: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
};

export const useShellProfilesStore = create<ShellProfilesState>((set, get) => ({
  profiles: [],
  defaultProfile: null,
  isLoaded: false,
  load: async () => {
    if (get().isLoaded) return;
    await get().refresh();
  },
  // Always re-fetches (unlike the gated load()). Call after changing the
  // default-profile setting so new tabs pick up the new default — which the main
  // process resolves from settings — without an app restart.
  refresh: async () => {
    const { profiles, defaultProfileId } = await window.fleet.shellProfiles.list();
    const defaultProfile = profiles.find((p) => p.id === defaultProfileId) ?? profiles[0] ?? null;
    set({ profiles, defaultProfile, isLoaded: true });
  }
}));
