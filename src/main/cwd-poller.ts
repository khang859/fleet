import { readlink } from 'fs/promises';
import { execFile } from 'child_process';
import { EventBus } from './event-bus';
import type { PtyManager } from './pty-manager';

const POLL_INTERVAL_MS = 5000;

export class CwdPoller {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private osc7Seen = new Set<string>();

  constructor(
    private eventBus: EventBus,
    private ptyManager: PtyManager,
  ) {}

  startPolling(paneId: string, pid: number): void {
    if (this.timers.has(paneId)) return;

    const timer = setInterval(async () => {
      if (this.osc7Seen.has(paneId)) {
        this.stopPolling(paneId);
        return;
      }
      const cwd = await readProcCwd(pid);
      if (cwd) {
        const current = this.ptyManager.getCwd(paneId);
        if (cwd !== current) {
          // Central handler in index.ts will call ptyManager.updateCwd
          this.eventBus.emit('cwd-changed', { type: 'cwd-changed', paneId, cwd });
        }
      }
    }, POLL_INTERVAL_MS);

    this.timers.set(paneId, timer);
  }

  markOsc7Seen(paneId: string): void {
    this.osc7Seen.add(paneId);
  }

  stopPolling(paneId: string): void {
    const timer = this.timers.get(paneId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(paneId);
    }
    this.osc7Seen.delete(paneId);
  }

  stopAll(): void {
    for (const paneId of this.timers.keys()) {
      clearInterval(this.timers.get(paneId)!);
    }
    this.timers.clear();
    this.osc7Seen.clear();
  }
}

async function readProcCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile(
        'lsof',
        ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'],
        { timeout: 1000 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const match = stdout.match(/^n(.+)$/m);
          resolve(match ? match[1] : null);
        },
      );
    });
  }

  return null;
}
