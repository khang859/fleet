// src/main/remote-ssh/pty-osc-bridge.ts

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { EventBus } from '../event-bus';
import { OscScanner } from '../osc-scanner';
import { isForeignOsc7Host } from '../osc-host';
import { createLogger } from '../logger';
import {
  toRemoteHost,
  type DetectedSshHost,
  type RemoteTransfer,
  type RemoteTransferRequest
} from '../../shared/remote-ssh-types';
import { remoteBasename } from './ssh-quote';
import { FLEET_OSC_CODE } from './rc-snippet';

const log = createLogger('remote-ssh:osc');

/**
 * Reads the escape sequences a terminal pane emits that Fleet acts on rather
 * than draws.
 *
 * It sits on the same seam as `NotificationDetector` - the main-process PTY data
 * callback - because every action here is main's to take: writing the system
 * clipboard, and starting an SFTP download. Parsing in the renderer would only
 * mean shipping the bytes back again. Main also sees the stream regardless of
 * whether the pane is on screen, which a background agent pane needs.
 */

/**
 * Base64 ceiling for a clipboard write, about 750 KB of text. Past this the
 * sequence is dropped: a terminal copy that large is a runaway program, and
 * decoding it would block the main thread.
 */
const MAX_CLIPBOARD_B64 = 1_000_000;

/** Longest remote path `fleet get` will act on. */
const MAX_REMOTE_PATH = 4096;

/** Remote output is untrusted, so a flood of download requests is rate limited. */
const GET_COOLDOWN_MS = 2_000;

/** Clipboard writes allowed per pane per window. Well above any human's copying. */
const MAX_CLIPBOARD_WRITES_PER_WINDOW = 10;
const CLIPBOARD_WINDOW_MS = 1_000;

export type PtyOscBridgeDeps = {
  eventBus: EventBus;
  /** True when the pane's foreground process is a remote-shell client. */
  isRemote: (paneId: string) => boolean;
  getPid: (paneId: string) => number | undefined;
  detectHost: (pid: number) => Promise<DetectedSshHost | null>;
  download: (request: RemoteTransferRequest) => Promise<void>;
  /** Reports a transfer that failed before the transfer manager could report it. */
  emitTransfer: (transfer: RemoteTransfer) => void;
  writeClipboard: (text: string) => void;
  downloadsDir: () => string;
};

export class PtyOscBridge {
  private readonly scanner = new OscScanner();
  private readonly lastGetAt = new Map<string, number>();
  private readonly clipboardWindows = new Map<string, { start: number; count: number }>();

  constructor(private readonly deps: PtyOscBridgeDeps) {
    deps.eventBus.on('pane-closed', (event) => {
      this.scanner.forget(event.paneId);
      this.lastGetAt.delete(event.paneId);
      this.clipboardWindows.delete(event.paneId);
    });
  }

  scan(paneId: string, data: string): void {
    for (const token of this.scanner.scan(paneId, data)) {
      if (token.code === 52) {
        this.handleClipboard(paneId, token.payload);
        continue;
      }
      // The remaining two only mean anything from a remote shell. Gating on that
      // also makes a chance byte sequence in local output (a binary file catted
      // to the screen) inert.
      //
      // OSC 7 takes the host name as a second, independent signal, because the
      // flag is a process poll behind and a remote shell's first prompt can
      // arrive before the poll has noticed the ssh.
      if (token.code === 7) {
        if (this.deps.isRemote(paneId) || isForeignOsc7Host(token.payload)) {
          this.handleRemoteCwd(paneId, token.payload);
        }
        continue;
      }
      if (token.code === FLEET_OSC_CODE && this.deps.isRemote(paneId)) {
        void this.handleFleetGet(paneId, token.payload);
      }
    }
  }

  /**
   * OSC 52 write: `<Pc>;<base64>`. This is how vim, tmux and friends put a yank
   * on the clipboard of whoever is looking at the terminal.
   *
   * The read form (`Pd` of `?`) is never answered. Replying would hand whatever
   * is on the user's clipboard to the remote host, which is a far worse trade
   * than the convenience is worth, so no code path exists for it at all.
   */
  private handleClipboard(paneId: string, payload: string): void {
    const sep = payload.indexOf(';');
    if (sep === -1) return;
    if (!this.allowClipboardWrite(paneId)) return;
    const text = decodeClipboardPayload(payload.slice(sep + 1));
    if (text === null) return;
    this.deps.writeClipboard(text);
  }

  /**
   * A budget rather than a cooldown, because copying twice in a second is normal
   * and must not be dropped. What this stops is a flood: each write decodes up to
   * 750 KB of base64 and then makes a blocking call into the OS clipboard, all on
   * the thread that also drives every other pane, so a remote host printing
   * thousands of them back to back would otherwise freeze the app.
   */
  private allowClipboardWrite(paneId: string): boolean {
    const now = Date.now();
    const bucket = this.clipboardWindows.get(paneId);
    if (!bucket || now - bucket.start >= CLIPBOARD_WINDOW_MS) {
      this.clipboardWindows.set(paneId, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    if (bucket.count === MAX_CLIPBOARD_WRITES_PER_WINDOW + 1) {
      log.warn('clipboard writes rate limited', { paneId });
    }
    return bucket.count <= MAX_CLIPBOARD_WRITES_PER_WINDOW;
  }

  /** OSC 7 from a remote shell: the working directory a dropped file lands in. */
  private handleRemoteCwd(paneId: string, payload: string): void {
    const cwd = parseFileUrlPath(payload);
    if (!cwd) return;
    this.deps.eventBus.emit('remote-cwd-changed', {
      type: 'remote-cwd-changed',
      paneId,
      cwd
    });
  }

  /**
   * `fleet get <path>` on the remote emits `get;<base64 path>`. Only the path
   * travels through the terminal; the bytes come down the SFTP connection Fleet
   * already holds open, so a large file neither floods the PTY nor blocks it.
   */
  private async handleFleetGet(paneId: string, payload: string): Promise<void> {
    if (!payload.startsWith('get;')) return;
    const remotePath = decodeRemotePath(payload.slice(4));
    if (!remotePath) return;

    const now = Date.now();
    const last = this.lastGetAt.get(paneId) ?? 0;
    if (now - last < GET_COOLDOWN_MS) {
      log.debug('fleet get rate limited', { paneId });
      return;
    }
    this.lastGetAt.set(paneId, now);

    const pid = this.deps.getPid(paneId);
    const detected = pid === undefined ? null : await this.deps.detectHost(pid);
    if (!detected) {
      log.debug('fleet get: no ssh host for pane', { paneId });
      return;
    }

    const name = remoteBasename(remotePath);
    const request: RemoteTransferRequest = {
      id: randomUUID(),
      paneId,
      host: toRemoteHost(detected),
      // Only the basename survives, so a remote path can never steer where the
      // file lands locally.
      localPath: uniqueDownloadPath(this.deps.downloadsDir(), name, existsSync),
      remotePath
    };

    try {
      await this.deps.download(request);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.debug('fleet get failed', { paneId, error });
      // A download that fails before the transfer manager starts reports nothing
      // of its own, so the row has to be raised here or the failure is silent.
      this.deps.emitTransfer({
        id: request.id,
        paneId,
        direction: 'download',
        name,
        transferred: 0,
        total: 0,
        state: 'error',
        error
      });
    }
  }
}

/** The text of an OSC 52 write, or null when it is a read request or unusable. */
export function decodeClipboardPayload(pd: string): string | null {
  if (pd === '?' || pd === '') return null;
  if (pd.length > MAX_CLIPBOARD_B64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pd)) return null;
  const text = Buffer.from(pd, 'base64').toString('utf-8');
  return text === '' ? null : text;
}

/** The absolute path out of a `fleet get` payload, or null if it is not one. */
export function decodeRemotePath(b64: string): string | null {
  if (b64.length === 0 || b64.length > MAX_REMOTE_PATH * 2) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const path = Buffer.from(b64, 'base64').toString('utf-8');
  if (!path.startsWith('/')) return null;
  if (path.length > MAX_REMOTE_PATH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return null;
  return path;
}

/** The path part of an OSC 7 `file://host/path` payload, or null. */
export function parseFileUrlPath(payload: string): string | null {
  if (!payload.startsWith('file://')) return null;
  try {
    const url = new URL(payload);
    try {
      return decodeURIComponent(url.pathname) || null;
    } catch {
      // A literal `%` in the path is not valid percent-encoding; the raw
      // pathname is still the right answer.
      return url.pathname || null;
    }
  } catch {
    return null;
  }
}

/**
 * A free name in the downloads folder. `fleet get` has no save dialog, so an
 * existing file is stepped around rather than replaced.
 */
export function uniqueDownloadPath(
  dir: string,
  name: string,
  exists: (path: string) => boolean
): string {
  const first = join(dir, name);
  if (!exists(first)) return first;

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 1000; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return join(dir, `${stem} (${randomUUID().slice(0, 8)})${ext}`);
}
