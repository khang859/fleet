import type { ClaudeSession } from '../../../shared/claude-sessions';
import type { FleetStarting } from './host';

/** `45s`, `3m`, `2h 5m`: how long, to the precision a person cares about. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** What a session is doing and for how long, in words. */
export function describePhase(session: ClaudeSession, now: number): string {
  const age = formatAge(now - session.phaseSince);
  switch (session.phase) {
    case 'starting':
      return `starting for ${age}`;
    case 'processing':
      return `working for ${age}`;
    case 'compacting':
      return `compacting for ${age}`;
    case 'waitingForApproval': {
      const tool = session.pendingPermissions.at(0)?.tool.toolName;
      return `waiting for approval${tool ? ` of ${tool}` : ''} for ${age}`;
    }
    case 'waitingForInput':
      return session.waitingKind === 'question'
        ? `waiting for an answer to a question for ${age}`
        : `waiting for a prompt for ${age}`;
    case 'ended':
      return 'ended';
  }
}

/** Whether the session is held up on the user: a permission or a question. */
export function needsUser(session: ClaudeSession): boolean {
  return (
    session.phase === 'waitingForApproval' ||
    (session.phase === 'waitingForInput' && session.waitingKind === 'question')
  );
}

/**
 * A spawned pane whose session has not reported yet. Claude Code runs no hooks
 * until its folder trust dialog is answered, so a long wait here is most often
 * that dialog - which is the user's to answer, never the Orchestrator's.
 */
export function describeStarting(spawn: FleetStarting, now: number): string {
  return `starting for ${formatAge(now - spawn.at)}; if this lasts, it is probably at the folder trust dialog, which only the user can answer`;
}
