import { create } from 'zustand';
import { createLogger } from '../logger';

const log = createLogger('store:cwd');

type CwdStore = {
  cwds: Map<string, string>;
  setCwd: (paneId: string, cwd: string) => void;
  removeCwd: (paneId: string) => void;
};

export const useCwdStore = create<CwdStore>((set) => ({
  cwds: new Map(),
  setCwd: (paneId, cwd) => {
    log.debug('setCwd', { paneId, cwd });
    set((state) => {
      const next = new Map(state.cwds);
      next.set(paneId, cwd);
      return { cwds: next };
    });
  },
  removeCwd: (paneId) => {
    log.debug('removeCwd', { paneId });
    set((state) => {
      const next = new Map(state.cwds);
      next.delete(paneId);
      return { cwds: next };
    });
  }
}));

export function initCwdListener(): () => void {
  return window.fleet.pty.onCwd(({ paneId, cwd }) => {
    log.debug('onCwd IPC received', { paneId, cwd });
    useCwdStore.getState().setCwd(paneId, cwd);
  });
}
