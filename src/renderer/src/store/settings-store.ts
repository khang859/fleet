import { create } from 'zustand';
import type { FleetSettings } from '../../../shared/types';
import { createLogger } from '../logger';

const log = createLogger('store:settings');

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
    log.debug('loadSettings');
    const settings = await window.fleet.settings.get();
    log.debug('loadSettings complete', { fontFamily: settings.general.fontFamily, fontSize: settings.general.fontSize });
    set({ settings, isLoaded: true });
  },

  updateSettings: async (partial) => {
    log.debug('updateSettings', { keys: Object.keys(partial) });
    await window.fleet.settings.set(partial);
    const settings = await window.fleet.settings.get();
    set({ settings });
  }
}));
