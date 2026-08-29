// src/shared/remote-ssh-types.ts

/**
 * A saved SSH target. Deliberately stores **no credentials** - only the
 * coordinates needed to build an `ssh` argv. Authentication is delegated
 * entirely to the user's own OpenSSH setup (~/.ssh/config, agent, key files),
 * which is why `identityFile` is a path *reference*, never key material.
 */
export type RemoteHost = {
  /** Stable id (uuid); survives label/host edits. */
  id: string;
  /** Human label for pickers, e.g. 'khang-linux'. */
  label: string;
  /** Hostname or a ~/.ssh/config Host alias. */
  host: string;
  user?: string;
  port?: number;
  /** Path to a private key, passed as `-i`. Never the key's contents. */
  identityFile?: string;
  /** Directory to open the browser at. Defaults to the login home dir. */
  defaultPath?: string;
};

export type RemoteEntryKind = 'file' | 'dir' | 'symlink' | 'other';

export type RemoteDirEntry = {
  name: string;
  /** Absolute POSIX path on the remote. */
  path: string;
  kind: RemoteEntryKind;
  size: number;
  /**
   * Modification time in ms since epoch, with sub-second precision preserved
   * from `find -printf '%T@'`. Cache freshness depends on this being exact -
   * `sftp`'s `ls -l` rendering is lossy (no year, no seconds) and cannot be
   * substituted here.
   */
  mtimeMs: number;
};

/** Remote capabilities probed once per connection, cached for its lifetime. */
export type RemoteCapabilities = {
  /** GNU findutils supports `-printf`; BSD/macOS `find` does not. */
  hasGnuFindPrintf: boolean;
};

export type RemoteListResult = { entries: RemoteDirEntry[]; resolvedPath: string };

/** A remote file materialized into the local cache, ready for a viewer pane. */
export type RemoteFetchResult = {
  /** Local cache path - safe to hand to fleet-image:// / fleet-pdf:// / fs. */
  localPath: string;
  size: number;
  mtimeMs: number;
};

/**
 * The remote origin of a file that has already been materialised locally.
 * A viewer holding one of these reads from the local cache copy but must write
 * back over SSH - `mtimeMs` is the remote mtime at fetch time, used as the
 * optimistic-concurrency token so a save can't silently clobber a newer file.
 */
export type RemoteFileRef = { host: RemoteHost; path: string; mtimeMs: number };

export type RemoteTextResult = {
  content: string;
  size: number;
  mtimeMs: number;
};

/**
 * An ssh destination recovered from a terminal pane's process tree. Advisory
 * only: it pre-fills a form the user confirms, and is never used directly to
 * build a remote command.
 */
export type DetectedSshHost = {
  /** The raw destination token from the ssh argv, e.g. 'knguyen@khang-linux'. */
  destination: string;
  user?: string;
  host: string;
  port?: number;
  identityFile?: string;
};

/**
 * A detected destination as a connectable host. The id is the destination string
 * rather than a uuid: this host is never saved, so it needs an identity only for
 * the length of one operation, and the destination is what the user typed.
 */
export function toRemoteHost(detected: DetectedSshHost): RemoteHost {
  return {
    id: detected.destination,
    label: detected.destination,
    host: detected.host,
    ...(detected.user !== undefined ? { user: detected.user } : {}),
    ...(detected.port !== undefined ? { port: detected.port } : {}),
    ...(detected.identityFile !== undefined ? { identityFile: detected.identityFile } : {})
  };
}

export type RemoteTransferDirection = 'download' | 'upload';

export type RemoteTransferState = 'active' | 'done' | 'error' | 'cancelled';

/**
 * A byte transfer in flight, reported to the renderer on a timer.
 *
 * `transferred` is observed rather than reported: `sftp` only prints its own
 * progress meter to a TTY, and this runs headless. A download is measured by
 * the size of the partial file being written locally; an upload by stat-ing the
 * growing file on the remote. That makes `transferred` a lower bound sampled at
 * the poll interval, which is what a progress bar needs and nothing more.
 */
export type RemoteTransfer = {
  /** Renderer-generated, so it can correlate progress and cancel before the IPC resolves. */
  id: string;
  /** Pane that started it, so a pane only renders its own transfers. */
  paneId: string;
  direction: RemoteTransferDirection;
  /** Basename shown in the UI. */
  name: string;
  transferred: number;
  /** 0 when the size could not be determined, which the UI renders indeterminate. */
  total: number;
  state: RemoteTransferState;
  error?: string;
};

export type RemoteTransferRequest = {
  id: string;
  paneId: string;
  host: RemoteHost;
  localPath: string;
  remotePath: string;
};

/** Discriminated result used by every remote-ssh IPC channel. */
export type RemoteResult<T> = { success: true; data: T } | { success: false; error: string };
