import { readlink } from 'fs/promises';
import pidCwd from 'pid-cwd';
import type { EventBus } from './event-bus';
import type { PtyManager } from './pty-manager';
import type { PathContext } from '../shared/shell-profiles';

const POLL_INTERVAL_MS = 5000;

export class CwdPoller {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private osc7Seen = new Set<string>();

  constructor(
    private eventBus: EventBus,
    private ptyManager: PtyManager
  ) {}

  startPolling(paneId: string, pid: number, pathContext: PathContext = 'posix'): void {
    if (this.timers.has(paneId)) return;
    // WSL panes only update via OSC 7 (installed by Phase 3's ensureFleetCli hook).
    // Polling the wsl.exe pid on the Windows side returns the wrong cwd because
    // the Linux-side shell's cwd is invisible to the Windows kernel.
    if (typeof pathContext === 'object' && pathContext.kind === 'wsl') {
      return;
    }

    const timer = setInterval(() => {
      if (this.osc7Seen.has(paneId)) {
        this.stopPolling(paneId);
        return;
      }
      void readProcCwd(pid).then((cwd) => {
        if (cwd) {
          const current = this.ptyManager.getCwd(paneId);
          if (cwd !== current) {
            this.eventBus.emit('cwd-changed', { type: 'cwd-changed', paneId, cwd, source: 'poll' });
          }
        }
      });
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
      clearInterval(this.timers.get(paneId));
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

  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      return await pidCwd(pid);
    } catch {
      return null;
    }
  }

  return null;
}
