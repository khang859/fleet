import { create } from 'zustand';
import type { ShellProfile } from '../../../shared/shell-profiles';

type ShellProfilesState = {
  profiles: ShellProfile[];
  defaultProfile: ShellProfile | null;
  isLoaded: boolean;
  load: () => Promise<void>;
};

export const useShellProfilesStore = create<ShellProfilesState>((set, get) => ({
  profiles: [],
  defaultProfile: null,
  isLoaded: false,
  load: async () => {
    if (get().isLoaded) return;
    const { profiles, defaultProfileId } = await window.fleet.shellProfiles.list();
    const defaultProfile = profiles.find((p) => p.id === defaultProfileId) ?? profiles[0] ?? null;
    set({ profiles, defaultProfile, isLoaded: true });
  }
}));
