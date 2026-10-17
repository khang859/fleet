import type { CopilotSession } from '../../../../shared/types';
import { needsUser } from '../../../../shared/claude-sessions';

export type SessionStatus = 'idle' | 'running' | 'permission' | 'complete';

export type SpriteState = 'idle' | 'processing' | 'permission' | 'complete';

function isWorking(session: CopilotSession): boolean {
  return session.phase === 'processing' || session.phase === 'compacting';
}

export function sessionStatus(session: CopilotSession): SessionStatus {
  if (needsUser(session)) return 'permission';
  if (isWorking(session)) return 'running';
  if (session.phase === 'ended') return 'complete';
  return 'idle';
}

export function statusLabel(session: CopilotSession): string {
  switch (session.phase) {
    case 'waitingForApproval':
      return 'Needs permission';
    case 'processing':
      return 'Working';
    case 'compacting':
      return 'Compacting';
    case 'waitingForInput':
      return session.waitingKind === 'question' ? 'Asking a question' : 'Ready';
    case 'starting':
      return 'Starting';
    case 'ended':
      return 'Ended';
    default:
      return 'Idle';
  }
}

/**
 * Sessions that need the user first, then working ones, then the rest. Ties
 * keep the order the sessions started in, so rows do not swap places as they update.
 */
export function sortSessions(a: CopilotSession, b: CopilotSession): number {
  const priority = (s: CopilotSession): number => {
    if (needsUser(s)) return 0;
    if (isWorking(s)) return 1;
    if (s.phase === 'waitingForInput') return 2;
    return 3;
  };
  return priority(a) - priority(b) || a.createdAt - b.createdAt;
}

/**
 * The first request with no answer on its way, so a failed or sending one does
 * not keep the Y / N keys from the requests after it.
 */
export function firstOpenPermission(
  sessions: CopilotSession[],
  answered: Record<string, unknown>
): string | null {
  const open = sessions.flatMap((s) => s.pendingPermissions).find((p) => !answered[p.toolUseId]);
  return open?.toolUseId ?? null;
}

/** True when a session that was working is now back at its prompt. */
export function turnFinished(prev: CopilotSession[], next: CopilotSession[]): boolean {
  const before = new Map(prev.map((s) => [s.sessionId, s]));
  return next.some((s) => {
    const old = before.get(s.sessionId);
    return (
      old !== undefined &&
      isWorking(old) &&
      s.phase === 'waitingForInput' &&
      s.waitingKind !== 'question'
    );
  });
}

/** The mascot's state. A request for the user outranks the short "turn done" moment. */
export function spriteStateFor(sessions: CopilotSession[], celebrating: boolean): SpriteState {
  if (sessions.some(needsUser)) return 'permission';
  if (celebrating) return 'complete';
  if (sessions.some(isWorking)) return 'processing';
  return 'idle';
}
