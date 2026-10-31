import type { ActivityState, NotificationLevel } from '../shared/types';
import type { ReportedActivity } from './reported-activity';

/** What a reported state is worth saying out loud, if anything. */
export function levelForReported(state: ActivityState): NotificationLevel | null {
  switch (state) {
    case 'needs_me':
      return 'permission';
    case 'error':
      return 'error';
    case 'done':
      return 'info';
    case 'working':
    case 'idle':
      return null;
  }
}

export type ActivityReportDeps = {
  /** Whether main already watches this pane's process. */
  isWatched: (paneId: string) => boolean;
  reported: ReportedActivity;
  /** Say it the way a prompt detected in a terminal is said. */
  emitNotification: (paneId: string, level: NotificationLevel) => void;
  /** Raise whatever alerts the distance to the user warrants. */
  raiseAlerts: (paneId: string, level: NotificationLevel) => void;
  /** Redraw the dock badge and the window title. */
  updateChrome: () => void;
};

/**
 * Take a pane at its word about what it is doing.
 *
 * Two different things arrive here. A pane main does not watch is reporting on
 * itself, and this is the only record of it there will be. A pane main *does*
 * watch is the agent saying it has left a command in a terminal for the user to
 * run - that goes back through the tracker that owns the pane, or the echo of
 * the command being typed would clear it a moment later and the user's own
 * Enter would clear nothing.
 */
export function routeActivityReport(
  report: { paneId: string; state: ActivityState | 'gone'; label?: string },
  deps: ActivityReportDeps
): void {
  const { paneId, state, label } = report;

  if (state === 'gone') {
    deps.reported.forget(paneId);
    deps.updateChrome();
    return;
  }

  if (deps.isWatched(paneId)) {
    if (state === 'needs_me') deps.emitNotification(paneId, 'permission');
    return;
  }

  // A question that is still waiting is not a new question: only a change is
  // worth a sound, which is the same rule main's own tracker follows.
  if (!deps.reported.set(paneId, state, label)) return;
  deps.updateChrome();
  const level = levelForReported(state);
  if (level !== null) deps.raiseAlerts(paneId, level);
}
