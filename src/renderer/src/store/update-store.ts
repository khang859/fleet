import { create } from 'zustand';
import type { UpdateStatus } from '../../../shared/types';

type UpdateStore = {
  status: UpdateStatus;
  /** Whether the release-notes dialog is up. */
  whatsNewOpen: boolean;
  setStatus: (status: UpdateStatus) => void;
  setWhatsNewOpen: (open: boolean) => void;
};

/**
 * The update the app is holding, and whether its notes are on screen.
 *
 * `App` used to keep a single boolean and throw away the version and notes that
 * came with the status, which was enough for a dot and nothing else. Three
 * places want the whole thing now - the pill in the title strip, the dialog it
 * opens, and the Settings section - so it lives here rather than being drilled
 * from `App` through `Sidebar`.
 */
export const useUpdateStore = create<UpdateStore>((set) => ({
  status: { state: 'idle' },
  whatsNewOpen: false,
  setStatus: (status) => set({ status }),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen })
}));

/** The staged update, or null while there is not one. */
export function pendingUpdate(
  status: UpdateStatus
): { version: string; releaseNotes: string } | null {
  return status.state === 'ready'
    ? { version: status.version, releaseNotes: status.releaseNotes }
    : null;
}
