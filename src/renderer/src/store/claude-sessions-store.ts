import { create } from 'zustand';
import type { ClaudeSessionView, ClaudeSessionsSnapshot } from '../../../shared/claude-sessions';

type ClaudeSessionsStore = {
  /** The latest snapshot from main; null until the first one arrives. */
  snapshot: ClaudeSessionsSnapshot | null;
};

export const useClaudeSessionsStore = create<ClaudeSessionsStore>(() => ({
  snapshot: null
}));

/**
 * Keep the store on main's latest snapshot. Subscribes before asking, so a
 * change landing between the two cannot be lost; the ask only fills the store
 * when nothing newer has arrived meanwhile.
 */
export function initClaudeSessionsListener(): () => void {
  let pushed = false;
  const unsubscribe = window.fleet.claudeSessions.onChanged((snapshot) => {
    pushed = true;
    useClaudeSessionsStore.setState({ snapshot });
  });
  void window.fleet.claudeSessions.list().then((snapshot) => {
    if (!pushed) useClaudeSessionsStore.setState({ snapshot });
  });
  return unsubscribe;
}

/**
 * How much a session wants the user:
 * - `needsYou`: blocked on a permission answer or a question dialog;
 * - `working`: running a turn or compacting;
 * - `ready`: finished its turn and waiting for a prompt;
 * - `idle`: known to Fleet but not yet said anything about its turn.
 */
export type SessionUrgency = 'needsYou' | 'working' | 'ready' | 'idle';

export function sessionUrgency(session: ClaudeSessionView): SessionUrgency {
  switch (session.phase) {
    case 'waitingForApproval':
      return 'needsYou';
    case 'waitingForInput':
      return session.waitingKind === 'question' ? 'needsYou' : 'ready';
    case 'processing':
    case 'compacting':
      return 'working';
    case 'starting':
    case 'ended':
      return 'idle';
  }
}

const URGENCY_RANK: Record<SessionUrgency, number> = { needsYou: 0, working: 1, ready: 2, idle: 2 };

/**
 * Sessions needing the user first, then working ones, then the rest. Within a
 * group, the one that has been in its state longest comes first: the oldest
 * unanswered question is the one to answer next.
 */
export function sortSessions(sessions: readonly ClaudeSessionView[]): ClaudeSessionView[] {
  return [...sessions].sort(
    (a, b) =>
      URGENCY_RANK[sessionUrgency(a)] - URGENCY_RANK[sessionUrgency(b)] ||
      a.phaseSince - b.phaseSince ||
      a.sessionId.localeCompare(b.sessionId)
  );
}

/** `12s`, `4m`, `2h`, `3d`: how long a session has been in its phase. */
export function formatPhaseAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Context use as a whole percentage, or null when unknown. */
export function contextPercent(session: ClaudeSessionView): number | null {
  const { contextTokens, contextLimit } = session.usage;
  if (contextTokens === null || !contextLimit) return null;
  return Math.min(100, Math.round((contextTokens / contextLimit) * 100));
}
