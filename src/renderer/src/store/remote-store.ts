import { create } from 'zustand';
import { createLogger } from '../logger';
import { useRemoteCwdStore } from './remote-cwd-store';

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
    // The remote working directory belonged to the session that just ended. Left
    // behind, it would aim the next drop at a directory on a host this pane is
    // no longer connected to.
    if (!remote) useRemoteCwdStore.getState().removeCwd(paneId);
  });
}
