import {
  attentionKey,
  cameUp,
  needsAttention,
  type ClaudeSession,
  type ClaudeSessionChange
} from '../../../shared/claude-sessions';

/**
 * When a Claude Code session starts to need the Orchestrator: it finishes a
 * turn, asks for approval, shows a question, or ends. `fleet_wait` blocks on
 * these, and the wakeup digests are made of them.
 */

/** What a session that needs attention is doing, to follow its name. */
export function describeAttention(session: ClaudeSession | null): string {
  if (session === null) return 'ended; its pane is gone';
  switch (session.phase) {
    case 'waitingForApproval': {
      const tool = session.pendingPermissions.at(0)?.tool.toolName;
      return `is waiting for the user to approve ${tool ?? 'a tool'}`;
    }
    case 'waitingForInput':
      return session.waitingKind === 'question'
        ? 'is showing the user a question'
        : 'finished its turn and is waiting for a prompt';
    case 'ended':
      return 'ended';
    case 'starting':
    case 'processing':
    case 'compacting':
      return 'is working';
  }
}

/** One session starting to need attention. `session` is null when its pane went away. */
export type AttentionItem = {
  /** Position in the log, the order changes arrived in. */
  n: number;
  paneId: string;
  sessionId: string;
  session: ClaudeSession | null;
};

/** Items kept; far more than a digest shows, since only the newest per pane is used. */
const LOG_SIZE = 200;

/**
 * Every attention change since Fleet started, and where each orchestrator
 * conversation has read up to.
 *
 * Kept here rather than read back from the registry's event ring because a
 * digest can wait on a busy pane for as long as its turn runs: by then an
 * ended session has left the registry and its events with it.
 *
 * It also knows which panes a running `fleet_wait` covers, and how far each
 * finished wait saw, so a digest never repeats what a wait already reported.
 */
export class FleetAttention {
  private n = 0;
  private readonly log: AttentionItem[] = [];
  private readonly keys = new Map<string, string>();
  private readonly panes = new Map<string, string>();
  private readonly cursors = new Map<string, number>();
  private readonly waits = new Map<string, ReadonlySet<string> | 'all'>();
  /** How far each thread's finished waits saw, by pane; `'*'` for a wait on every session. */
  private readonly waited = new Map<string, Map<string, number>>();

  /** Fed every registry change. */
  observe(change: ClaudeSessionChange): void {
    const { session, sessionId } = change;
    if (session !== null) {
      const key = attentionKey(session);
      const before = this.keys.get(sessionId);
      this.keys.set(sessionId, key);
      this.panes.set(sessionId, session.paneId);
      if (before !== key && needsAttention(session) && !cameUp(change)) {
        this.push({ paneId: session.paneId, sessionId, session });
      }
      return;
    }
    const before = this.keys.get(sessionId);
    const paneId = this.panes.get(sessionId);
    this.keys.delete(sessionId);
    this.panes.delete(sessionId);
    if (paneId === undefined) return;
    // Leaving after it ended was already told; leaving after a `/clear` is not
    // an ending, since the new session is in the same pane.
    if (before?.includes('|ended|') === true) return;
    if ([...this.panes.values()].includes(paneId)) return;
    this.push({ paneId, sessionId, session: null });
  }

  private push(item: Omit<AttentionItem, 'n'>): void {
    this.log.push({ ...item, n: ++this.n });
    if (this.log.length > LOG_SIZE) this.log.shift();
  }

  /** Orchestrator mode turned on: what happened before is not news to this conversation. */
  startAt(threadId: string): void {
    this.cursors.set(threadId, this.n);
    this.waited.delete(threadId);
  }

  /** Orchestrator mode turned off. */
  forget(threadId: string): void {
    this.cursors.delete(threadId);
    this.waited.delete(threadId);
  }

  /**
   * The newest attention change per pane since the thread last took a digest,
   * leaving out panes a wait is covering or has already reported on.
   */
  pending(threadId: string): AttentionItem[] {
    const cursor = this.cursors.get(threadId) ?? 0;
    const waited = this.waited.get(threadId);
    const newest = new Map<string, AttentionItem>();
    for (const item of this.log) {
      if (item.n <= cursor || this.covers(threadId, item.paneId)) continue;
      const seen = Math.max(waited?.get(item.paneId) ?? 0, waited?.get('*') ?? 0);
      if (item.n <= seen) continue;
      newest.delete(item.paneId);
      newest.set(item.paneId, item);
    }
    return [...newest.values()];
  }

  /** Everything up to now has been dealt with by this thread. */
  advance(threadId: string): void {
    this.cursors.set(threadId, this.n);
    this.waited.delete(threadId);
  }

  /** Mark a `fleet_wait` as running; the returned function ends it. */
  hold(threadId: string, panes: ReadonlySet<string> | 'all'): () => void {
    this.waits.set(threadId, panes);
    return () => {
      if (this.waits.get(threadId) !== panes) return;
      this.waits.delete(threadId);
      const waited = this.waited.get(threadId) ?? new Map<string, number>();
      for (const pane of panes === 'all' ? ['*'] : panes) waited.set(pane, this.n);
      this.waited.set(threadId, waited);
    };
  }

  covers(threadId: string, paneId: string): boolean {
    const panes = this.waits.get(threadId);
    return panes === 'all' || (panes?.has(paneId) ?? false);
  }
}
