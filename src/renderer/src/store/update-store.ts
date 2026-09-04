import { create } from 'zustand';
import type { UpdateStatus } from '../../../shared/types';

/** A downloaded update, sitting on disk waiting to be installed. */
export type StagedUpdate = { version: string; releaseNotes: string };

type UpdateStore = {
  /** The latest thing the updater said. Transient: a check moves it about. */
  status: UpdateStatus;
  /** The update that is actually installable, if there is one. */
  staged: StagedUpdate | null;
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
 *
 * `staged` is deliberately not derived from `status`. A downloaded update stays
 * on disk and stays installable no matter what the updater says next, and with
 * a check now running every four hours there is always a next thing: the first
 * one to fail offline would otherwise move the status to `error` and take the
 * pill, the sidebar dot and the install button with it, leaving the user unable
 * to install an update that is sitting right there. So `status` carries what
 * just happened and `staged` carries what can be installed, and only a newer
 * `ready` replaces it.
 */
export const useUpdateStore = create<UpdateStore>((set) => ({
  status: { state: 'idle' },
  staged: null,
  whatsNewOpen: false,
  setStatus: (status) =>
    set(
      status.state === 'ready'
        ? { status, staged: { version: status.version, releaseNotes: status.releaseNotes } }
        : { status }
    ),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen })
}));
