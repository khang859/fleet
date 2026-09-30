import { execFileSync } from 'child_process';
import { createLogger } from '../logger';
import type { PanePlacement } from './registry';

const log = createLogger('claude-sessions:pane-resolver');

/** The live panes of this Fleet instance. */
export type PaneHost = {
  has(paneId: string): boolean;
  paneIds(): string[];
  getPid(paneId: string): number | undefined;
};

export type WorkspaceInfo = { workspaceId: string; workspaceName: string };

/** The workspace a pane sits in, or null when the saved layout does not know it yet. */
export type WorkspaceLookup = (paneId: string) => WorkspaceInfo | null;

/** A process's parent, or null when it cannot be read. */
export type ParentOf = (pid: number) => number | null;

/** How far up from Claude to look for the pane's shell: Claude, a wrapper, a shell. */
const MAX_WALK_DEPTH = 5;

export function psParentOf(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 });
    const ppid = parseInt(out.toString().trim(), 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch {
    return null;
  }
}

/**
 * Finds the Fleet pane a hook event came from.
 *
 * Hook binaries from protocol 2 on forward the pane's `FLEET_PANE_ID`; it is
 * trusted only if this instance has that pane, which also rejects an id that
 * leaked in from another Fleet or through tmux or ssh. Older binaries send no
 * id, and the pane is found by walking up from the Claude process to a pane's
 * shell. Only hits are cached, so a miss is retried on the next event.
 */
export class PaneResolver {
  private readonly paneByPid = new Map<number, string>();
  private readonly workspaceByPane = new Map<string, WorkspaceInfo>();

  constructor(
    private readonly panes: PaneHost,
    private readonly workspaceOf: WorkspaceLookup,
    private readonly parentOf: ParentOf = psParentOf
  ) {}

  resolve(event: { paneId?: string; pid?: number }): PanePlacement | null {
    const paneId = this.paneFor(event);
    if (!paneId) return null;
    const workspace = this.workspaceFor(paneId);
    return workspace ? { paneId, ...workspace } : { paneId };
  }

  /** Forget what was cached about a pane that closed. */
  forgetPane(paneId: string): void {
    this.workspaceByPane.delete(paneId);
    for (const [pid, cached] of this.paneByPid) {
      if (cached === paneId) this.paneByPid.delete(pid);
    }
  }

  private paneFor(event: { paneId?: string; pid?: number }): string | null {
    if (event.paneId && this.panes.has(event.paneId)) return event.paneId;
    if (event.paneId) log.debug('ignoring unknown pane id', { paneId: event.paneId });
    if (!event.pid) return null;

    const cached = this.paneByPid.get(event.pid);
    if (cached && this.panes.has(cached)) return cached;
    this.paneByPid.delete(event.pid);

    const found = this.walk(event.pid);
    if (found) this.paneByPid.set(event.pid, found);
    return found;
  }

  private walk(pid: number): string | null {
    const shells = new Map<number, string>();
    for (const paneId of this.panes.paneIds()) {
      const shellPid = this.panes.getPid(paneId);
      if (shellPid !== undefined) shells.set(shellPid, paneId);
    }
    let current = pid;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      const parent = this.parentOf(current);
      if (parent === null || parent <= 1) return null;
      const paneId = shells.get(parent);
      if (paneId) return paneId;
      current = parent;
    }
    return null;
  }

  private workspaceFor(paneId: string): WorkspaceInfo | null {
    const cached = this.workspaceByPane.get(paneId);
    if (cached) return cached;
    // A new pane may not be in the saved layout yet; the next event asks again.
    const found = this.workspaceOf(paneId);
    if (found) this.workspaceByPane.set(paneId, found);
    return found;
  }
}
