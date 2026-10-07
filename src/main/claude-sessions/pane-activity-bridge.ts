import type { ActivityState } from '../../shared/types';
import type { ClaudeSession, ClaudeSessionChange } from '../../shared/claude-sessions';

/** Sets the hook-derived state for a pane, or clears it when given null. */
export type SetHookState = (paneId: string, state: ActivityState | null, pid?: number) => void;

/**
 * Translate what the agent says about itself into the vocabulary the pane
 * badges speak. `ended` maps to null: the session is over, so the pane goes
 * back to the heuristics rather than freezing on a stale hook state.
 *
 * Only a session blocked on the user - a permission answer or a question
 * dialog - is `needs_me`. A finished turn sitting at its prompt is at rest,
 * not asking: lighting every idle Claude pane amber made the signal mean nothing.
 */
export function phaseToActivityState(
  session: Pick<ClaudeSession, 'phase' | 'waitingKind'>
): ActivityState | null {
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return 'working';
    case 'waitingForApproval':
      return 'needs_me';
    case 'waitingForInput':
      return session.waitingKind === 'question' ? 'needs_me' : 'idle';
    case 'starting':
      return 'idle';
    case 'ended':
      return null;
  }
}

/**
 * Pushes each Claude session's phase onto the pane it runs in, so the main
 * window's badges report what the agent is actually doing instead of
 * inferring it from terminal output. Runs whether or not the copilot does.
 */
export class PaneActivityBridge {
  private readonly paneBySession = new Map<string, string>();

  constructor(private readonly setHookState: SetHookState) {}

  apply(change: ClaudeSessionChange): void {
    const { sessionId, session } = change;
    const previous = this.paneBySession.get(sessionId);

    if (!session || session.phase === 'ended') {
      this.paneBySession.delete(sessionId);
      if (previous) this.releaseIfUnclaimed(previous);
      return;
    }

    this.paneBySession.set(sessionId, session.paneId);
    if (previous && previous !== session.paneId) this.releaseIfUnclaimed(previous);
    this.setHookState(session.paneId, phaseToActivityState(session), session.pid);
  }

  /** Release every pane. Used when tracking stops. */
  clear(): void {
    const panes = new Set(this.paneBySession.values());
    this.paneBySession.clear();
    for (const paneId of panes) this.setHookState(paneId, null);
  }

  /** A pane is released only when no other live session has taken it over. */
  private releaseIfUnclaimed(paneId: string): void {
    for (const other of this.paneBySession.values()) if (other === paneId) return;
    this.setHookState(paneId, null);
  }
}
