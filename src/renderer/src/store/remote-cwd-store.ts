import { create } from 'zustand';
import { createLogger } from '../logger';

const log = createLogger('store:remote-cwd');

/**
 * Where the shell on the far side of an ssh pane is standing, as reported by
 * Fleet's remote rc snippet.
 *
 * Kept apart from `cwd-store` rather than merged into it: that store writes
 * through to the saved layout so a pane reopens where it was, and a path from
 * another machine has no meaning there. This one is session state and nothing
 * else - it is what tells a dropped file where to land.
 */
type RemoteCwdStore = {
  cwds: Map<string, string>;
  setCwd: (paneId: string, cwd: string) => void;
  removeCwd: (paneId: string) => void;
};

export const useRemoteCwdStore = create<RemoteCwdStore>((set) => ({
  cwds: new Map(),
  setCwd: (paneId, cwd) => {
    log.debug('setCwd', { paneId, cwd });
    set((state) => {
      if (state.cwds.get(paneId) === cwd) return state;
      const next = new Map(state.cwds);
      next.set(paneId, cwd);
      return { cwds: next };
    });
  },
  removeCwd: (paneId) => {
    set((state) => {
      if (!state.cwds.has(paneId)) return state;
      const next = new Map(state.cwds);
      next.delete(paneId);
      return { cwds: next };
    });
  }
}));

/** Mirror main-process remote-cwd updates into the store. Called once from App. */
export function initRemoteCwdListener(): () => void {
  return window.fleet.remote.onCwdChange(({ paneId, cwd }) => {
    useRemoteCwdStore.getState().setCwd(paneId, cwd);
  });
}
