import { createLogger } from '../logger';
import { isProcessAlive } from '../process-liveness';
import type { ActivityState, CopilotSession, CopilotSessionPhase } from '../../shared/types';

const log = createLogger('copilot:pane-activity');

/** Sets the hook-derived state for a pane, or clears it when given null. */
export type SetHookState = (paneId: string, state: ActivityState | null, pid?: number) => void;

/** Resolves the Fleet pane that owns a Claude Code process, or null. */
export type FindPaneForPid = (pid: number) => string | null;

/**
 * Translate what the agent says about itself into the vocabulary the pane
 * badges speak. `ended` maps to null: the session is over, so the pane goes
 * back to the heuristics rather than freezing on a stale hook state.
 */
export function phaseToActivityState(phase: CopilotSessionPhase): ActivityState | null {
  switch (phase) {
    case 'processing':
    case 'compacting':
      return 'working';
    case 'waitingForApproval':
    case 'waitingForInput':
      return 'needs_me';
    case 'idle':
      return 'idle';
    case 'ended':
      return null;
  }
}

/**
 * Pushes Claude Code hook state onto the panes those sessions run in, so the
 * main window's badges report what the agent is actually doing instead of
 * inferring it from terminal output.
 */
export class CopilotPaneActivity {
  /**
   * sessionId to paneId, including the null misses. Resolving a pane shells out
   * to `ps` several times, and hook events arrive on every tool call, so each
   * session is resolved once. A miss is cached too: a session run in a terminal
   * Fleet does not own would otherwise pay for that walk forever.
   */
  private paneBySession = new Map<string, string | null>();

  constructor(
    private readonly setHookState: SetHookState,
    private readonly findPaneForPid: FindPaneForPid,
    private readonly isAlive: (pid: number) => boolean = isProcessAlive
  ) {}

  /** Apply the live session list. Sessions that have gone release their pane. */
  sync(sessions: CopilotSession[]): void {
    const live = new Set<string>();

    for (const session of sessions) {
      // Mark it live before resolving, so a session Fleet owns no pane for keeps
      // its cached miss instead of being re-resolved on the next hook event.
      live.add(session.sessionId);

      const paneId = this.resolvePane(session);
      if (!paneId) continue;

      // A session whose process is gone is not describing anything any more.
      // Claude Code quit with `/exit` sends no closing hook, so the store keeps
      // the session, and without this check the next hook event from any other
      // agent would re-assert this dead state onto its pane.
      const alive = session.pid !== undefined && this.isAlive(session.pid);
      const state = alive ? phaseToActivityState(session.phase) : null;

      this.setHookState(paneId, state, session.pid);
    }

    for (const [sessionId, paneId] of this.paneBySession) {
      if (live.has(sessionId)) continue;
      if (paneId) this.setHookState(paneId, null);
      this.paneBySession.delete(sessionId);
    }
  }

  /** Release every pane. Used when the copilot service stops. */
  clear(): void {
    this.sync([]);
  }

  private resolvePane(session: CopilotSession): string | null {
    const cached = this.paneBySession.get(session.sessionId);
    if (cached !== undefined) return cached;

    // No PID yet. Don't cache the miss — the next hook event usually carries one.
    if (!session.pid) return null;

    const paneId = this.findPaneForPid(session.pid);
    this.paneBySession.set(session.sessionId, paneId);
    log.debug('resolved session pane', { sessionId: session.sessionId, pid: session.pid, paneId });
    return paneId;
  }
}
