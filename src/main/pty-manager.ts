import * as pty from 'node-pty';
import { getDefaultShell } from './shell-detection';
import { createLogger } from './logger';
import { PtySession, type PtyShutdownReason } from './pty-session';

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
  /** For resolving per-workspace Claude config (e.g. CLAUDE_CONFIG_DIR). */
  workspaceId?: string;
};

export type PtyCreateResult = {
  paneId: string;
  pid: number;
};

const FLUSH_INTERVAL_MS = 16;

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  /** PTYs that must not be killed by the renderer-driven GC. */
  private protectedPtys = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  create(opts: PtyCreateOptions): PtyCreateResult {
    const existing = this.sessions.get(opts.paneId);
    if (existing) {
      // Idempotent: return existing PTY info (handles HMR reloads in dev where the
      // renderer-side createdPtys Set is reset but the main process map persists)
      log.debug('PTY already exists, returning existing pid', {
        paneId: opts.paneId,
        pid: existing.pid
      });
      return { paneId: opts.paneId, pid: existing.pid };
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

    const session = new PtySession({
      process: proc,
      paneId: opts.paneId,
      cwd: opts.cwd,
      onEnded: (paneId) => this.removeSession(paneId)
    });
    this.sessions.set(opts.paneId, session);

    return { paneId: opts.paneId, pid: session.pid };
  }

  write(paneId: string, data: string): void {
    this.sessions.get(paneId)?.write(data);
  }

  resize(paneId: string, cols: number, rows: number): void {
    this.sessions.get(paneId)?.resize(cols, rows);
  }

  protect(paneId: string): void {
    this.protectedPtys.add(paneId);
  }

  kill(paneId: string): void {
    this.shutdownSession(paneId, 'user');
  }

  killAll(): void {
    for (const paneId of Array.from(this.sessions.keys())) {
      this.shutdownSession(paneId, 'app-quit');
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  has(paneId: string): boolean {
    return this.sessions.has(paneId);
  }

  get(paneId: string): PtySession | undefined {
    return this.sessions.get(paneId);
  }

  paneIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getCwd(paneId: string): string | undefined {
    return this.sessions.get(paneId)?.cwd;
  }

  updateCwd(paneId: string, cwd: string): void {
    const session = this.sessions.get(paneId);
    if (session) session.cwd = cwd;
  }

  getPid(paneId: string): number | undefined {
    return this.sessions.get(paneId)?.pid;
  }

  /** Returns the current foreground process name for a PTY (e.g. "zsh", "node", "claude"). */
  getProcessName(paneId: string): string | undefined {
    return this.sessions.get(paneId)?.processName;
  }

  /** Kill any PTY whose paneId is not in the given set of active IDs (and not protected). */
  gc(activePaneIds: Set<string>): string[] {
    const killed: string[] = [];
    for (const paneId of Array.from(this.sessions.keys())) {
      if (!activePaneIds.has(paneId) && !this.protectedPtys.has(paneId)) {
        this.shutdownSession(paneId, 'gc');
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
    const session = this.sessions.get(paneId);
    if (!session) return;

    session.onData(callback);

    // Start shared flush timer if not already running
    this.flushTimer ??= setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  /** Resume a paused PTY (called by renderer after consuming a batch). */
  resume(paneId: string): void {
    this.sessions.get(paneId)?.resume();
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    this.sessions.get(paneId)?.onExit(callback);
  }

  drainBuffer(paneId: string): { data: string; wasPaused: boolean } | undefined {
    return this.sessions.get(paneId)?.drainBuffer();
  }

  private shutdownSession(paneId: string, reason: PtyShutdownReason): void {
    const session = this.sessions.get(paneId);
    if (!session) return;
    session.shutdown(reason);
  }

  private removeSession(paneId: string): void {
    this.sessions.delete(paneId);
    this.protectedPtys.delete(paneId);
    this.clearFlushTimerIfEmpty();
  }

  private clearFlushTimerIfEmpty(): void {
    if (this.sessions.size === 0 && this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushAll(): void {
    for (const session of this.sessions.values()) {
      session.flush();
    }
  }
}
