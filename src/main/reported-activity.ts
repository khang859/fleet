import type { ActivityState } from '../shared/types';

/**
 * The state of panes that have no process for main to watch.
 *
 * `ActivityTracker` learns what a terminal is doing by watching its PTY. An
 * agent pane runs nothing main can see, so it reports itself and this holds
 * what it said - only so that the dock badge and window title, which are main's
 * to draw, can count every pane waiting rather than only the ones with a shell
 * in them.
 *
 * Kept apart from `ActivityTracker` on purpose: nothing here is observed, it is
 * all hearsay from the renderer, and the two should not be mistaken for each
 * other when reading either.
 */
type Reported = { state: ActivityState; label: string | undefined };

export class ReportedActivity {
  private readonly panes = new Map<string, Reported>();

  /** Returns whether the state changed, so callers can skip a no-op. */
  set(paneId: string, state: ActivityState, label?: string): boolean {
    const previous = this.panes.get(paneId);
    // The label is kept even when the state stands still, and a report without
    // one does not erase the last one we were given: it is what this pane is
    // called, not what it is doing.
    this.panes.set(paneId, { state, label: label ?? previous?.label });
    return previous?.state !== state;
  }

  forget(paneId: string): void {
    this.panes.delete(paneId);
  }

  get(paneId: string): ActivityState | undefined {
    return this.panes.get(paneId)?.state;
  }

  labelOf(paneId: string): string | undefined {
    return this.panes.get(paneId)?.label;
  }

  has(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /** Live counts awaiting attention, in the shape `ActivityTracker` reports. */
  getCounts(): { needsMe: number; error: number; working: number } {
    let needsMe = 0;
    let error = 0;
    let working = 0;
    for (const { state } of this.panes.values()) {
      if (state === 'needs_me') needsMe++;
      else if (state === 'error') error++;
      else if (state === 'working') working++;
    }
    return { needsMe, error, working };
  }
}
