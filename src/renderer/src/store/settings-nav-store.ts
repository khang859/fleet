import { create } from 'zustand';
import type { SettingsSection } from '../components/settings/SettingsNav';

type SettingsNavStore = {
  /** A section asked for from outside Settings, waiting for the Settings tab to show it. */
  pending: SettingsSection | null;
  clear: () => void;
};

export const useSettingsNavStore = create<SettingsNavStore>((set) => ({
  pending: null,
  clear: () => set({ pending: null })
}));

/** Open Settings, or bring its tab forward, at a given section. */
export function openSettings(section: SettingsSection): void {
  useSettingsNavStore.setState({ pending: section });
  document.dispatchEvent(new CustomEvent('fleet:toggle-settings'));
}
