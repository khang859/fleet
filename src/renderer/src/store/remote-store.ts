import { create } from 'zustand';
import { createLogger } from '../logger';

const log = createLogger('store:remote');

type RemoteStore = {
  /** paneIds whose foreground process is a remote-shell client (ssh, mosh, …). */
  remotes: Set<string>;
  setRemote: (paneId: string, remote: boolean) => void;
};

export const useRemoteStore = create<RemoteStore>((set) => ({
  remotes: new Set(),
  setRemote: (paneId, remote) => {
    log.debug('setRemote', { paneId, remote });
    set((state) => {
      const next = new Set(state.remotes);
      if (remote) {
        next.add(paneId);
      } else {
        next.delete(paneId);
      }
      return { remotes: next };
    });
  }
}));

export function initRemoteListener(): () => void {
  return window.fleet.remote.onStateChange(({ paneId, remote }) => {
    log.debug('onRemote IPC received', { paneId, remote });
    useRemoteStore.getState().setRemote(paneId, remote);
  });
}
