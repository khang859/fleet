import { readlink, realpath } from 'fs/promises';
import pidCwd from 'pid-cwd';
import type { EventBus } from './event-bus';
import type { PtyManager } from './pty-manager';
import { isWslContext, type PathContext } from '../shared/shell-profiles';

const POLL_INTERVAL_MS = 5000;

export class CwdPoller {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private eventBus: EventBus,
    private ptyManager: PtyManager
  ) {}

  startPolling(paneId: string, pid: number, pathContext: PathContext = 'posix'): void {
    if (this.timers.has(paneId)) return;
    // WSL panes only update via OSC 7 (installed by Phase 3's ensureFleetCli hook).
    // Polling the wsl.exe pid on the Windows side returns the wrong cwd because
    // the Linux-side shell's cwd is invisible to the Windows kernel.
    if (isWslContext(pathContext)) {
      return;
    }

    // Keeps running once the shell reports its folder itself (OSC 7): that
    // report only comes at a prompt, so `cd project && claude` moves the shell
    // without one until the command ends.
    const timer = setInterval(() => {
      void readProcCwd(pid).then((cwd) => {
        if (cwd) void this.report(paneId, cwd);
      });
    }, POLL_INTERVAL_MS);

    this.timers.set(paneId, timer);
  }

  /**
   * Resolve a pane's live cwd on demand (e.g. before opening the Env Editor, in
   * case the folder was renamed/moved out from under the cached path). Emits a
   * `cwd-changed` event if it differs so the rest of the app stays in sync.
   * Returns the resolved cwd, or null if it can't be determined (no pid, or a
   * WSL pane where pidCwd is unreliable — those only update via OSC 7).
   */
  async resolveNow(paneId: string, pathContext: PathContext = 'posix'): Promise<string | null> {
    if (isWslContext(pathContext)) {
      return null;
    }
    const pid = this.ptyManager.getPid(paneId);
    if (pid === undefined) return null;
    const cwd = await readProcCwd(pid);
    if (!cwd) return null;
    await this.report(paneId, cwd);
    return cwd;
  }

  /**
   * Emit `cwd-changed` when the shell is somewhere other than the pane's known
   * folder. The process's folder has its symlinks resolved, while the one a
   * shell reports through OSC 7 may not, so the known folder is resolved before
   * the two are compared: otherwise each poll would swap the path the shell
   * gave for its resolved form.
   */
  private async report(paneId: string, cwd: string): Promise<void> {
    const known = this.ptyManager.getCwd(paneId);
    if (cwd === known) return;
    if (known !== undefined && (await realpath(known).catch(() => null)) === cwd) return;
    this.eventBus.emit('cwd-changed', { type: 'cwd-changed', paneId, cwd, source: 'poll' });
  }

  stopPolling(paneId: string): void {
    const timer = this.timers.get(paneId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(paneId);
    }
  }

  stopAll(): void {
    for (const paneId of this.timers.keys()) {
      clearInterval(this.timers.get(paneId));
    }
    this.timers.clear();
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
