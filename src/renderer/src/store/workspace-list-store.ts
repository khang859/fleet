import { create } from 'zustand';
import { createLogger } from '../logger';

const log = createLogger('store:workspace-list');

export type SavedWorkspace = { id: string; label: string };

type WorkspaceListState = {
  /** Every workspace on disk, including the active one. */
  workspaces: SavedWorkspace[];
  loaded: boolean;
  /** Re-read the list from disk. Safe to call from anywhere, any number of times. */
  refresh: () => Promise<void>;
  /** Reflect a rename before the next refresh lands. */
  applyRename: (workspaceId: string, label: string) => void;
  /** Reflect a delete before the next refresh lands. */
  applyDelete: (workspaceId: string) => void;
};

/**
 * The saved-workspace list, in one place.
 *
 * The sidebar and the Workspaces settings page both show it, and both can now
 * change it - creating a workspace from Settings has to appear in the sidebar,
 * and a rename or delete in the sidebar has to appear in Settings. Each side
 * used to load the list once on mount into its own state, so whichever one was
 * not doing the writing showed a stale list until it was remounted.
 *
 * Explicit invalidation rather than polling: every mutation already knows it
 * happened, so it calls `refresh` (or one of the two optimistic helpers, when
 * showing the change immediately matters more than a round trip).
 */
export const useWorkspaceListStore = create<WorkspaceListState>((set) => ({
  workspaces: [],
  loaded: false,

  refresh: async () => {
    try {
      const res = await window.fleet.layout.list();
      set({
        workspaces: res.workspaces.map((w) => ({ id: w.id, label: w.label })),
        loaded: true
      });
    } catch (err) {
      log.error('failed to list workspaces', { error: String(err) });
    }
  },

  applyRename: (workspaceId, label) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, label } : w))
    }));
  },

  applyDelete: (workspaceId) => {
    set((s) => ({ workspaces: s.workspaces.filter((w) => w.id !== workspaceId) }));
  }
}));
