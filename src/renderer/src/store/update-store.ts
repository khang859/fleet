import { create } from 'zustand';
import type { StagedUpdate, UpdateSnapshot, UpdateStatus } from '../../../shared/types';

type UpdateStore = {
  /** The latest thing the updater said. Transient: a check moves it about. */
  status: UpdateStatus;
  /** The update that is actually installable, if there is one. */
  staged: StagedUpdate | null;
  /** Whether the release-notes dialog is up. */
  whatsNewOpen: boolean;
  setSnapshot: (snapshot: UpdateSnapshot) => void;
  dismissStatus: () => void;
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
 * This is a mirror, not a source. `status` and `staged` come apart - a check
 * runs every four hours, so one failing offline must not take the pill and the
 * install button down with it - but deciding when a *staged* update stops being
 * installable needs to know what the updater did to the file on disk, which
 * only the main process sees. So main decides both and sends them together, and
 * this holds what it was told. See `nextStaged` in `src/main/update-staging.ts`.
 */
export const useUpdateStore = create<UpdateStore>((set) => ({
  status: { state: 'idle' },
  staged: null,
  whatsNewOpen: false,
  setSnapshot: ({ status, staged }) => set({ status, staged }),
  /**
   * Drop a finished answer without touching what is staged.
   *
   * Only for "you're up to date", which is a reply to a button the user just
   * pressed rather than a state of the world worth keeping on screen.
   */
  dismissStatus: () => set({ status: { state: 'idle' } }),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen })
}));
