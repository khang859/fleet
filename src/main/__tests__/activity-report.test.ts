import { describe, it, expect, vi } from 'vitest';
import { routeActivityReport, levelForReported, type ActivityReportDeps } from '../activity-report';
import { ReportedActivity } from '../reported-activity';

function harness(watched: string[] = []): {
  deps: ActivityReportDeps;
  emitNotification: ReturnType<typeof vi.fn>;
  raiseAlerts: ReturnType<typeof vi.fn>;
  updateChrome: ReturnType<typeof vi.fn>;
  reported: ReportedActivity;
} {
  const reported = new ReportedActivity();
  const emitNotification = vi.fn();
  const raiseAlerts = vi.fn();
  const updateChrome = vi.fn();
  return {
    reported,
    emitNotification,
    raiseAlerts,
    updateChrome,
    deps: {
      isWatched: (paneId) => watched.includes(paneId),
      reported,
      emitNotification,
      raiseAlerts,
      updateChrome
    }
  };
}

describe('levelForReported', () => {
  it('says nothing about a pane that is merely busy or done being busy', () => {
    expect(levelForReported('working')).toBeNull();
    expect(levelForReported('idle')).toBeNull();
  });

  it('separates a question from a failure from a finished turn', () => {
    expect(levelForReported('needs_me')).toBe('permission');
    expect(levelForReported('error')).toBe('error');
    expect(levelForReported('done')).toBe('info');
  });
});

describe('routeActivityReport', () => {
  it('records a pane main does not watch, and raises what it is worth', () => {
    const h = harness();

    routeActivityReport({ paneId: 'agent-1', state: 'needs_me' }, h.deps);

    expect(h.reported.get('agent-1')).toBe('needs_me');
    expect(h.raiseAlerts).toHaveBeenCalledWith('agent-1', 'permission');
    expect(h.updateChrome).toHaveBeenCalled();
  });

  it('raises nothing for a pane that is only working', () => {
    const h = harness();

    routeActivityReport({ paneId: 'agent-1', state: 'working' }, h.deps);

    expect(h.raiseAlerts).not.toHaveBeenCalled();
    // The dock still gets redrawn: this pane may have been counted a moment ago.
    expect(h.updateChrome).toHaveBeenCalled();
  });

  it('does not raise the same question twice', () => {
    const h = harness();

    routeActivityReport({ paneId: 'agent-1', state: 'needs_me' }, h.deps);
    routeActivityReport({ paneId: 'agent-1', state: 'needs_me' }, h.deps);

    expect(h.raiseAlerts).toHaveBeenCalledTimes(1);
  });

  /*
   * The hand-off. The agent typed a command into a terminal and is waiting for
   * the user's Enter, and that terminal is a pane main already watches - so it
   * goes back through the tracker rather than into the map of panes that report
   * themselves, or the echo of the command being typed would clear it.
   */
  it('routes a watched pane back through the tracker instead of recording it', () => {
    const h = harness(['terminal-1']);

    routeActivityReport({ paneId: 'terminal-1', state: 'needs_me' }, h.deps);

    expect(h.emitNotification).toHaveBeenCalledWith('terminal-1', 'permission');
    expect(h.reported.has('terminal-1')).toBe(false);
    expect(h.raiseAlerts).not.toHaveBeenCalled();
  });

  it('ignores anything else said about a pane main watches for itself', () => {
    const h = harness(['terminal-1']);

    routeActivityReport({ paneId: 'terminal-1', state: 'done' }, h.deps);

    expect(h.emitNotification).not.toHaveBeenCalled();
    expect(h.reported.has('terminal-1')).toBe(false);
  });

  /*
   * No `pane-closed` is emitted for a pane without a PTY, so this is the only
   * word main gets. Left counted, it is a dock badge for a question that can no
   * longer be answered and a palette entry that arrives nowhere.
   */
  it('forgets a pane that has gone, and redraws without it', () => {
    const h = harness();
    routeActivityReport({ paneId: 'agent-1', state: 'needs_me' }, h.deps);

    routeActivityReport({ paneId: 'agent-1', state: 'gone' }, h.deps);

    expect(h.reported.has('agent-1')).toBe(false);
    expect(h.reported.getCounts()).toEqual({ needsMe: 0, error: 0 });
    expect(h.updateChrome).toHaveBeenCalledTimes(2);
  });

  it('keeps the folder name for the notification that will name it', () => {
    const h = harness();

    routeActivityReport({ paneId: 'agent-1', state: 'needs_me', label: 'fleet' }, h.deps);

    expect(h.reported.labelOf('agent-1')).toBe('fleet');
  });
});
