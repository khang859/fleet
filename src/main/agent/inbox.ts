import type { AgentMessage } from '../../shared/agent-types';

/**
 * Messages the client sent while an Admiral turn was running, waiting for its
 * next round. Closed once the turn has nothing left to take them in, so a late
 * message is refused and the pane sends it as a turn of its own instead.
 */
export class AgentInbox {
  private queued: AgentMessage[] = [];
  private closed = false;

  /** False once the turn can no longer take the message in. */
  put(message: AgentMessage): boolean {
    if (this.closed) return false;
    this.queued.push(message);
    return true;
  }

  /** Everything waiting, in the order it was sent. */
  take(): AgentMessage[] {
    const taken = this.queued;
    this.queued = [];
    return taken;
  }

  pending(): boolean {
    return this.queued.length > 0;
  }

  close(): void {
    this.closed = true;
  }
}
