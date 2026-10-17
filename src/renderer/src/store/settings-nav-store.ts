import { create } from 'zustand';
import type { SettingsSection } from '../components/settings/SettingsNav';

type SettingsNavStore = {
  /** A section asked for from outside Settings, waiting for the Settings tab to show it. */
  pending: SettingsSection | null;
  /** The project whose client file the Admiral settings should show first. */
  clientFileRepoId: string | null;
  clear: () => void;
};

export const useSettingsNavStore = create<SettingsNavStore>((set) => ({
  pending: null,
  clientFileRepoId: null,
  clear: () => set({ pending: null })
}));

/** Open Settings, or bring its tab forward, at a given section. */
export function openSettings(section: SettingsSection): void {
  useSettingsNavStore.setState({ pending: section });
  document.dispatchEvent(new CustomEvent('fleet:toggle-settings'));
}

/** Open Settings › Agency › Admiral on a project's client file. */
export function openClientFileSettings(repoId: string): void {
  useSettingsNavStore.setState({ clientFileRepoId: repoId });
  openSettings('agencyAdmiral');
}
