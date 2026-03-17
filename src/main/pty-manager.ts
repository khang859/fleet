import * as pty from 'node-pty';
import { getDefaultShell } from './shell-detection';

export type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  cols?: number;
  rows?: number;
};

export type PtyCreateResult = {
  paneId: string;
  pid: number;
};

type PtyEntry = {
  process: pty.IPty;
  paneId: string;
  cwd: string;
};

export class PtyManager {
  private ptys = new Map<string, PtyEntry>();
  /** PTYs that must not be killed by the renderer-driven GC (e.g. Star Command crews). */
  private protectedPtys = new Set<string>();

  create(opts: PtyCreateOptions): PtyCreateResult {
    if (this.ptys.has(opts.paneId)) {
      throw new Error(`${opts.paneId} already exists`);
    }

    const shell = opts.shell ?? getDefaultShell();
    const args: string[] = [];

    if (opts.cmd) {
      args.push('-c', `${opts.cmd}; exec ${shell}`);
    }

    console.log(`[pty] shell="${shell}" cwd="${opts.cwd}" PATH="${process.env.PATH?.substring(0, 80)}"`);
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: process.env as Record<string, string>,
    });

    this.ptys.set(opts.paneId, { process: proc, paneId: opts.paneId, cwd: opts.cwd });

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
      entry.process.resize(cols, rows);
    }
  }

  protect(paneId: string): void {
    this.protectedPtys.add(paneId);
  }

  kill(paneId: string): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.kill();
      this.ptys.delete(paneId);
      this.protectedPtys.delete(paneId);
    }
  }

  killAll(): void {
    for (const [paneId] of this.ptys) {
      this.kill(paneId);
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

  onData(paneId: string, callback: (data: string) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.onData(callback);
    }
  }

  onExit(paneId: string, callback: (exitCode: number) => void): void {
    const entry = this.ptys.get(paneId);
    if (entry) {
      entry.process.onExit(({ exitCode }) => {
        this.ptys.delete(paneId);
        this.protectedPtys.delete(paneId);
        callback(exitCode);
      });
    }
  }
}
