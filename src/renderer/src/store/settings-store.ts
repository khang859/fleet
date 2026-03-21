import { create } from 'zustand';
import type { FleetSettings } from '../../../shared/types';

type SettingsStoreState = {
  settings: FleetSettings | null;
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<FleetSettings>) => Promise<void>;
};

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: null,
  isLoaded: false,

  loadSettings: async () => {
    const settings = await window.fleet.settings.get();
    set({ settings, isLoaded: true });
  },

  updateSettings: async (partial) => {
    await window.fleet.settings.set(partial);
    const settings = await window.fleet.settings.get();
    set({ settings });
  }
}));
