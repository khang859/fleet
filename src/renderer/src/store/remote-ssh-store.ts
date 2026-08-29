import { create } from 'zustand';
import type {
  RemoteDirEntry,
  RemoteHost,
  RemoteTransfer,
  RemoteTransferDirection
} from '../../../shared/remote-ssh-types';
import { createLogger } from '../logger';
import { remoteChildPath } from '../lib/remote-names';

const log = createLogger('store:remote-ssh');

export type SortKey = 'name' | 'size' | 'modified';
export type SortDir = 'asc' | 'desc';
export type ViewMode = 'list' | 'grid';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export type BrowserPaneState = {
  host: RemoteHost;
  cwd: string;
  entries: RemoteDirEntry[];
  loading: boolean;
  error: string | null;
  connection: ConnectionState;
  sortKey: SortKey;
  sortDir: SortDir;
  view: ViewMode;
  /** Path of the focused row, for keyboard navigation. */
  focused: string | null;
  /** Directories visited, so Back walks the trail the user actually took. */
  history: string[];
  historyIndex: number;
};

type RemoteSshStore = {
  /**
   * Per-pane browsing state. Explicitly `| undefined` because a pane id is only
   * present between `openPane` and `closePane` - without it TypeScript would
   * hand every reader a non-nullable value that is routinely missing at runtime.
   */
  panes: Record<string, BrowserPaneState | undefined>;
  openPane: (paneId: string, host: RemoteHost, initialPath?: string) => Promise<void>;
  closePane: (paneId: string) => void;
  navigate: (paneId: string, path: string, opts?: { replaceHistory?: boolean }) => Promise<void>;
  refresh: (paneId: string) => Promise<void>;
  goUp: (paneId: string) => Promise<void>;
  goBack: (paneId: string) => Promise<void>;
  goForward: (paneId: string) => Promise<void>;
  setSort: (paneId: string, key: SortKey) => void;
  setView: (paneId: string, view: ViewMode) => void;
  setFocused: (paneId: string, path: string | null) => void;

  /**
   * Transfers in flight, keyed by id. Kept flat rather than nested under a pane
   * because progress arrives from the main process by id, and a transfer must
   * survive its pane being scrolled, re-sorted, or navigated elsewhere.
   */
  transfers: Record<string, RemoteTransfer | undefined>;
  applyTransfer: (transfer: RemoteTransfer) => void;
  dismissTransfer: (id: string) => void;
  /**
   * Start a transfer and keep the pane's listing in step when it lands. Resolves
   * true once the bytes have landed - the terminal drop path only types the
   * remote path after that, so a failed upload never leaves a path at the prompt
   * pointing at a file that is not there.
   */
  startTransfer: (
    direction: RemoteTransferDirection,
    args: { paneId: string; host: RemoteHost; localPath: string; remotePath: string }
  ) => Promise<boolean>;
  cancelTransfer: (id: string) => void;

  /**
   * Mutations. Each resolves to an error message to show in place, or null on
   * success - the caller is a dialog that stays open until the operation lands,
   * so a failure has somewhere to be read rather than vanishing into a toast.
   */
  createFolder: (paneId: string, name: string) => Promise<string | null>;
  renameEntry: (paneId: string, entry: RemoteDirEntry, newName: string) => Promise<string | null>;
  removeEntry: (paneId: string, entry: RemoteDirEntry) => Promise<string | null>;
};

/**
 * `transfers` is keyed for deletion, so reading it back gives `| undefined`.
 * Panes that render a list narrow through this.
 */
export function isTransfer(t: RemoteTransfer | undefined): t is RemoteTransfer {
  return t !== undefined;
}

/** How long a finished row lingers before it clears itself. */
const SETTLED_TRANSFER_MS = 4_000;

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/**
 * Apply the active sort. Directories always lead regardless of sort key -
 * mixing them into a size or date ordering makes a file tree much harder to
 * scan, and every familiar file manager keeps them grouped.
 */
export function applySort(entries: RemoteDirEntry[], key: SortKey, dir: SortDir): RemoteDirEntry[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'dir';
    const bDir = b.kind === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1;
    if (key === 'size') return (a.size - b.size) * factor;
    if (key === 'modified') return (a.mtimeMs - b.mtimeMs) * factor;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * factor;
  });
}

export const useRemoteSshStore = create<RemoteSshStore>((set, get) => ({
  panes: {},

  openPane: async (paneId, host, initialPath) => {
    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: {
          host,
          cwd: initialPath ?? '',
          entries: [],
          loading: true,
          error: null,
          connection: 'connecting',
          sortKey: 'name',
          sortDir: 'asc',
          view: 'list',
          focused: null,
          history: [],
          historyIndex: -1
        }
      }
    }));

    let start = initialPath;
    if (!start) {
      const home = await window.fleet.remoteSsh.home(host);
      if (!home.success) {
        set((state) => {
          const pane = state.panes[paneId];
          if (!pane) return state;
          return {
            panes: {
              ...state.panes,
              [paneId]: { ...pane, loading: false, error: home.error, connection: 'error' }
            }
          };
        });
        return;
      }
      start = home.data;
    }
    await get().navigate(paneId, start);
  },

  closePane: (paneId) => {
    set((state) => {
      const next = { ...state.panes };
      delete next[paneId];
      return { panes: next };
    });
  },

  navigate: async (paneId, path, opts) => {
    const pane = get().panes[paneId];
    if (!pane) return;

    set((state) => ({
      panes: { ...state.panes, [paneId]: { ...pane, loading: true, error: null } }
    }));

    const result = await window.fleet.remoteSsh.list(pane.host, path);
    const current = get().panes[paneId];
    // The pane may have been closed or navigated away while the call was in flight.
    if (!current) return;

    if (!result.success) {
      log.debug('list failed', { paneId, path, error: result.error });
      set((state) => ({
        panes: {
          ...state.panes,
          [paneId]: {
            ...current,
            loading: false,
            error: result.error,
            connection: 'error'
          }
        }
      }));
      return;
    }

    const { entries, resolvedPath } = result.data;
    const history =
      opts?.replaceHistory || current.history[current.historyIndex] === resolvedPath
        ? current.history
        : [...current.history.slice(0, current.historyIndex + 1), resolvedPath];

    set((state) => ({
      panes: {
        ...state.panes,
        [paneId]: {
          ...current,
          cwd: resolvedPath,
          entries: applySort(entries, current.sortKey, current.sortDir),
          loading: false,
          error: null,
          connection: 'connected',
          focused:
            entries.length > 0
              ? applySort(entries, current.sortKey, current.sortDir)[0].path
              : null,
          history,
          historyIndex: history === current.history ? current.historyIndex : history.length - 1
        }
      }
    }));
  },

  refresh: async (paneId) => {
    const pane = get().panes[paneId];
    if (!pane) return;
    await get().navigate(paneId, pane.cwd, { replaceHistory: true });
  },

  goUp: async (paneId) => {
    const pane = get().panes[paneId];
    if (!pane || pane.cwd === '/') return;
    await get().navigate(paneId, parentOf(pane.cwd));
  },

  goBack: async (paneId) => {
    const pane = get().panes[paneId];
    if (!pane || pane.historyIndex <= 0) return;
    const target = pane.history[pane.historyIndex - 1];
    set((state) => ({
      panes: { ...state.panes, [paneId]: { ...pane, historyIndex: pane.historyIndex - 1 } }
    }));
    await get().navigate(paneId, target, { replaceHistory: true });
  },

  goForward: async (paneId) => {
    const pane = get().panes[paneId];
    if (!pane || pane.historyIndex >= pane.history.length - 1) return;
    const target = pane.history[pane.historyIndex + 1];
    set((state) => ({
      panes: { ...state.panes, [paneId]: { ...pane, historyIndex: pane.historyIndex + 1 } }
    }));
    await get().navigate(paneId, target, { replaceHistory: true });
  },

  setSort: (paneId, key) => {
    set((state) => {
      const pane = state.panes[paneId];
      if (!pane) return state;
      // Clicking the active column flips direction; a new column starts ascending.
      const sortDir: SortDir = pane.sortKey === key && pane.sortDir === 'asc' ? 'desc' : 'asc';
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            sortKey: key,
            sortDir,
            entries: applySort(pane.entries, key, sortDir)
          }
        }
      };
    });
  },

  setView: (paneId, view) => {
    set((state) => {
      const pane = state.panes[paneId];
      if (!pane) return state;
      return { panes: { ...state.panes, [paneId]: { ...pane, view } } };
    });
  },

  setFocused: (paneId, path) => {
    set((state) => {
      const pane = state.panes[paneId];
      if (!pane) return state;
      return { panes: { ...state.panes, [paneId]: { ...pane, focused: path } } };
    });
  },

  transfers: {},

  applyTransfer: (transfer) => {
    set((state) => ({ transfers: { ...state.transfers, [transfer.id]: transfer } }));
    // A row that succeeded has nothing left to say, so it retires itself. Errors
    // stay until dismissed - the user has to be able to read what went wrong.
    if (transfer.state === 'done' || transfer.state === 'cancelled') {
      setTimeout(() => get().dismissTransfer(transfer.id), SETTLED_TRANSFER_MS);
    }
  },

  dismissTransfer: (id) => {
    set((state) => {
      const next = { ...state.transfers };
      delete next[id];
      return { transfers: next };
    });
  },

  startTransfer: async (direction, args) => {
    const id = crypto.randomUUID();
    const request = { id, ...args };
    const result =
      direction === 'download'
        ? await window.fleet.remoteSsh.download(request)
        : await window.fleet.remoteSsh.upload(request);

    if (!result.success) {
      // The main process only emits progress once a transfer starts, so a
      // failure to even begin has to be surfaced here or it is silent.
      get().applyTransfer({
        id,
        paneId: args.paneId,
        direction,
        name: basenameOf(direction === 'download' ? args.remotePath : args.localPath),
        transferred: 0,
        total: 0,
        state: 'error',
        error: result.error
      });
      return false;
    }
    // An upload changes what the pane is looking at; a download does not. A
    // terminal pane has no listing, so `refresh` is a no-op there.
    if (direction === 'upload') await get().refresh(args.paneId);
    return true;
  },

  cancelTransfer: (id) => {
    void window.fleet.remoteSsh.cancelTransfer(id);
  },

  createFolder: async (paneId, name) => {
    const pane = get().panes[paneId];
    if (!pane) return PANE_GONE;
    const path = remoteChildPath(pane.cwd, name);

    // sftp answers a duplicate mkdir with the word "Failure" and nothing else,
    // which tells the user nothing. Checking first costs one round trip and buys
    // by far the most common failure an actual explanation.
    const existing = await window.fleet.remoteSsh.stat(pane.host, path);
    if (existing.success && existing.data) {
      return `"${name}" already exists in this folder.`;
    }

    const result = await window.fleet.remoteSsh.mkdir(pane.host, path);
    if (!result.success) return result.error;
    await get().refresh(paneId);
    get().setFocused(paneId, path);
    return null;
  },

  renameEntry: async (paneId, entry, newName) => {
    const pane = get().panes[paneId];
    if (!pane) return PANE_GONE;
    const to = remoteChildPath(parentOf(entry.path), newName);
    if (to === entry.path) return null;

    // OpenSSH's rename is posix-rename, which *silently replaces* an existing
    // target. That is exactly right for an atomic save and exactly wrong for a
    // user rename, so the destination is checked first. The check races a
    // concurrent writer, which is the same window every file manager has.
    const existing = await window.fleet.remoteSsh.stat(pane.host, to);
    if (existing.success && existing.data) {
      return `"${newName}" already exists in this folder.`;
    }

    const result = await window.fleet.remoteSsh.rename(pane.host, entry.path, to);
    if (!result.success) return result.error;
    await get().refresh(paneId);
    get().setFocused(paneId, to);
    return null;
  },

  removeEntry: async (paneId, entry) => {
    const pane = get().panes[paneId];
    if (!pane) return PANE_GONE;
    // A symlink reports its own kind, so it is unlinked rather than followed -
    // deleting a link must never delete what it points at.
    const result = await window.fleet.remoteSsh.remove(pane.host, entry.path, entry.kind === 'dir');
    if (!result.success) return result.error;
    await get().refresh(paneId);
    return null;
  }
}));

const PANE_GONE = 'This browser pane is no longer open.';

function basenameOf(path: string): string {
  return path.split('/').pop() || path;
}

/** Mirror main-process transfer progress into the store. Called once from App. */
export function initRemoteTransferListener(): () => void {
  return window.fleet.remoteSsh.onTransfer((transfer) => {
    log.debug('transfer', { id: transfer.id, state: transfer.state });
    useRemoteSshStore.getState().applyTransfer(transfer);
  });
}
