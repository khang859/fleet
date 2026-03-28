import * as pty from 'node-pty';
import { getDefaultShell } from './shell-detection';
import { createLogger } from './logger';

const log = createLogger('pty');

export type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
  /** If true, the PTY exits when cmd finishes instead of falling back to a shell.
   *  Used for crew PTYs where we need onExit to fire for cleanup. */
  exitOnComplete?: boolean;
};

export type PtyCreateResult = {
  paneId: string;
  pid: number;
};

type PtyEntry = {
  process: pty.IPty;
  paneId: string;
  cwd: string;
  outputBuffer: string;
  paused: boolean;
  dataDisposable: pty.IDisposable | null;
  exitDisposable: pty.IDisposable | null;
};

const FLUSH_INTERVAL_MS = 16;
const BUFFER_OVERFLOW_BYTES = 256 * 1024;

export class PtyManager {
  private ptys = new Map<string, PtyEntry>();
  /** PTYs that must not be killed by the renderer-driven GC. */
  private protectedPtys = new Set<string>();
  private dataCallbacks = new Map<string, (data: string, paused: boolean) => void>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  create(opts: PtyCreateOptions): PtyCreateResult {
    if (this.ptys.has(opts.paneId)) {
      // Idempotent: return existing PTY info (handles HMR reloads in dev where the
      // renderer-side createdPtys Set is reset but the main process map persists)
      const existing = this.ptys.get(opts.paneId);
      if (!existing) return { paneId: opts.paneId, pid: 0 };
      log.debug('PTY already exists, returning existing pid', {
        paneId: opts.paneId,
        pid: existing.process.pid
      });
      return { paneId: opts.paneId, pid: existing.process.pid };
    }

    const shell = opts.shell ?? getDefaultShell();
    const args: string[] = [];

    if (opts.cmd) {
      if (opts.exitOnComplete) {
        // PTY exits when command finishes — used for crew agents where onExit triggers cleanup
        args.push('-c', opts.cmd);
      } else {
        // Default: fall back to shell after command exits — keeps terminal alive for user
        args.push('-c', `${opts.cmd}; exec ${shell}`);
      }
    }

    log.debug('spawning PTY', {
      shell,
      cwd: opts.cwd,
      pathPrefix: process.env.PATH?.substring(0, 80)
    });
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), FLEET_SESSION: '1' }
    });

    const entry: PtyEntry = {
      process: proc,
      paneId: opts.paneId,
      cwd: opts.cwd,
      outputBuffer: '',
      paused: false,
      dataDisposable: null,
      exitDisposable: null
    };

    // Register the internal buffering callback immediately at create time so
    // the IDisposable is captured and can be disposed during kill().
    entry.dataDisposable = proc.onData((data: string) => {
      entry.outputBuffer += data;
      if (entry.outputBuffer.length > BUFFER_OVERFLOW_BYTES) {
        log.debug('backpressure pause', {
          paneId: opts.paneId,
          bufferBytes: entry.outputBuffer.length
        });
        entry.paused = true;
        this.flushPane(opts.paneId);
        proc.pause();
      }
    });

    this.ptys.set(opts.paneId, entry);

    return { paneId: opts.paneId, pid: proc.pid };
  }

  write(paneId: string, data: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.write(data);
    }
  }

  resize(paneId: string, cols: number, rows: number): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('resize', { paneId, cols, rows });
      entry.process.resize(cols, rows);
    }
  }

  protect(paneId: string): void {
    this.protectedPtys.add(paneId);
  }

  kill(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('kill', { paneId, pid: entry.process.pid });
      entry.dataDisposable?.dispose();
      entry.exitDisposable?.dispose();
      this.dataCallbacks.delete(paneId);
      entry.process.kill();
      this.ptys.delete(paneId);
      this.protectedPtys.delete(paneId);
      this.clearFlushTimerIfEmpty();
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.kill(paneId);
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  has(paneId: string): boolean {
    return this.ptys.has(paneId);
  }

  get(paneId: string): PtyEntry | undefined {
    return this.ptys.get(paneId);
  }

  paneIds(): string[] {
    return Array.from(this.ptys.keys());
  }

  getCwd(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.cwd;
  }

  updateCwd(paneId: string, cwd: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) entry.cwd = cwd;
  }

  getPid(paneId: string): number | undefined {
    return this.ptys.get(paneId)?.process.pid;
  }

  /** Returns the current foreground process name for a PTY (e.g. "zsh", "node", "claude"). */
  getProcessName(paneId: string): string | undefined {
    return this.ptys.get(paneId)?.process.process;
  }

  /** Kill any PTY whose paneId is not in the given set of active IDs (and not protected). */
  gc(activePaneIds: Set<string>): string[] {
    const killed: string[] = [];
    for (const paneId of this.ptys.keys()) {
      if (!activePaneIds.has(paneId) && !this.protectedPtys.has(paneId)) {
        this.kill(paneId);
        killed.push(paneId);
      }
    }
    return killed;
  }

  /**
   * Register a callback that receives batched PTY output every ~16ms.
   * The internal process.onData listener is already registered at create() time;
   * this method wires up the flush callback and starts the shared flush timer.
   */
  onData(paneId: string, callback: (data: string, paused: boolean) => void): void {
    const entry = this.ptys.get(paneId);
    if (!entry) return;

    if (this.dataCallbacks.has(paneId)) {
      log.warn('onData already registered for pane, skipping to prevent silent overwrite', {
        paneId
      });
      return;
    }

    this.dataCallbacks.set(paneId, callback);

    // Start shared flush timer if not already running
    this.flushTimer ??= setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  /** Resume a paused PTY (called by renderer after consuming a batch). */
  resume(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      log.debug('resume', { paneId });
      entry.paused = false;
      entry.process.resume();
    }
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      // Dispose previous exit listener to prevent stacking (e.g. on HMR re-register)
      entry.exitDisposable?.dispose();
      entry.exitDisposable = entry.process.onExit(({ exitCode }) => {
        log.debug('exit', { paneId, exitCode });
        entry.dataDisposable?.dispose();
        this.dataCallbacks.delete(paneId);
        this.ptys.delete(paneId);
        this.protectedPtys.delete(paneId);
        this.clearFlushTimerIfEmpty();
        callback(exitCode);
      });
    }
  }

  private clearFlushTimerIfEmpty(): void {
    if (this.ptys.size === 0 && this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushPane(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (!entry?.outputBuffer) return;
    const callback = this.dataCallbacks.get(paneId);
    if (callback) {
      callback(entry.outputBuffer, entry.paused);
      entry.outputBuffer = '';
    }
  }

  private flushAll(): void {
    for (const paneId of this.ptys.keys()) {
      this.flushPane(paneId);
    }
  }
}
