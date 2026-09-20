import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityTracker } from '../activity-tracker';
import { EventBus } from '../event-bus';

describe('ActivityTracker', () => {
  let eventBus: EventBus;
  let tracker: ActivityTracker;
  let getProcessName: ReturnType<typeof vi.fn<(paneId: string) => string | undefined>>;
  let isProcessAlive: ReturnType<typeof vi.fn<(pid: number) => boolean>>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    getProcessName = vi.fn<(paneId: string) => string | undefined>().mockReturnValue('zsh');
    isProcessAlive = vi.fn<(pid: number) => boolean>().mockReturnValue(true);
    tracker = new ActivityTracker(eventBus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 2000,
      getProcessName,
      isProcessAlive
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('transitions to working on data received', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'activity-state-change',
        paneId: 'pane-1',
        state: 'working'
      })
    );
  });

  it('transitions to idle after silence threshold', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    callback.mockClear();

    vi.advanceTimersByTime(5000);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'idle'
      })
    );
  });

  it('resets silence timer on new data', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    vi.advanceTimersByTime(4000);
    tracker.onData('pane-1'); // reset timer
    callback.mockClear();

    vi.advanceTimersByTime(4000); // 4s after reset, still under 5s
    expect(callback).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));

    vi.advanceTimersByTime(1000); // now 5s after reset
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
  });

  it('transitions to done on process exit code 0', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onExit('pane-1', 0);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'done'
      })
    );
  });

  it('transitions to error on process exit code != 0', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onExit('pane-1', 1);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'error'
      })
    );
  });

  it('transitions to needs_me on permission signal', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onNeedsMe('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'needs_me'
      })
    );
  });

  it('needs_me overrides working state', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    callback.mockClear();

    tracker.onNeedsMe('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'needs_me'
      })
    );
  });

  it('keeps needs_me when a blocked agent keeps emitting output', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onNeedsMe('pane-1');
    callback.mockClear();

    // Permission prompt repaints arrive as PTY output — must not clear needs_me.
    tracker.onData('pane-1');
    tracker.onData('pane-1');

    expect(callback).not.toHaveBeenCalled();
    expect(tracker.getState('pane-1')).toBe('needs_me');
  });

  it('clears needs_me back to working on user input', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onNeedsMe('pane-1');
    callback.mockClear();

    tracker.onUserInput('pane-1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', state: 'working' })
    );
  });

  it('does not emit duplicate states', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    tracker.onData('pane-1');
    tracker.onData('pane-1');

    // Should only emit once for 'working' — subsequent data events
    // in the same state are deduped
    const workingCalls = callback.mock.calls.filter((c) => c[0].state === 'working');
    expect(workingCalls).toHaveLength(1);
  });

  it('cleans up pane on untrack', () => {
    tracker.trackPane('pane-1');
    tracker.onData('pane-1');
    tracker.untrackPane('pane-1');

    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    // Should not emit after untrack
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('uses process polling to detect idle at shell prompt', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onData('pane-1'); // state = working
    callback.mockClear();

    // Simulate silence + shell at prompt
    getProcessName.mockReturnValue('zsh');
    vi.advanceTimersByTime(2000); // process poll fires

    // Process poll alone doesn't override — but combined with silence at 5s:
    vi.advanceTimersByTime(3000); // total 5s silence

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
  });

  it('counts panes needing attention across needs_me and error states', () => {
    tracker.trackPane('pane-1');
    tracker.trackPane('pane-2');
    tracker.trackPane('pane-3');

    tracker.onNeedsMe('pane-1');
    tracker.onNeedsMe('pane-2');
    tracker.onExit('pane-3', 1);

    expect(tracker.getCounts()).toEqual({ needsMe: 2, error: 1, working: 0 });
  });

  // The close guard reads this: a pane mid-command is the difference between a
  // quit that costs nothing and one that cuts work off.
  it('counts panes that are mid-command', () => {
    tracker.trackPane('pane-1');
    tracker.trackPane('pane-2');

    tracker.onData('pane-1');

    expect(tracker.getCounts()).toEqual({ needsMe: 0, error: 0, working: 1 });
  });

  it('excludes untracked panes from counts', () => {
    tracker.trackPane('pane-1');
    tracker.onNeedsMe('pane-1');
    tracker.untrackPane('pane-1');

    expect(tracker.getCounts()).toEqual({ needsMe: 0, error: 0, working: 0 });
  });
  describe('hook state', () => {
    it('lets a hook state override the heuristic one', () => {
      tracker.trackPane('pane-1');
      tracker.onData('pane-1');
      expect(tracker.getState('pane-1')).toBe('working');

      tracker.setHookState('pane-1', 'needs_me');

      expect(tracker.getState('pane-1')).toBe('needs_me');
    });

    it('ignores output bursts while a hook owns the pane', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'idle');

      tracker.onData('pane-1');

      expect(tracker.getState('pane-1')).toBe('idle');
    });

    it('ignores the permission regex while a hook owns the pane', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'working');

      // A `(y/n)` in a build log is what onNeedsMe fires on — the hook says the
      // agent is busy, so the false alarm must not reach the badge.
      tracker.onNeedsMe('pane-1');

      expect(tracker.getState('pane-1')).toBe('working');
    });

    it('ignores the silence timer while a hook owns the pane', () => {
      tracker.trackPane('pane-1');
      tracker.onData('pane-1');
      tracker.setHookState('pane-1', 'working');

      vi.advanceTimersByTime(5001);

      expect(tracker.getState('pane-1')).toBe('working');
    });

    it('hands the pane back to the heuristics when the hook state is cleared', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'idle');
      tracker.setHookState('pane-1', null);

      tracker.onData('pane-1');

      expect(tracker.getState('pane-1')).toBe('working');
    });

    it('lets exit win over a live hook state', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'working');

      tracker.onExit('pane-1', 1);

      expect(tracker.getState('pane-1')).toBe('error');
    });

    it('emits a state change for the hook state', () => {
      const callback = vi.fn();
      eventBus.on('activity-state-change', callback);

      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'needs_me');

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ paneId: 'pane-1', state: 'needs_me' })
      );
    });

    it('releases a stale hook state once the agent process is gone', () => {
      // Quitting Claude Code with `/exit` sends no closing hook, so the poll is
      // the only thing that can notice the agent has gone.
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'working', 4242);

      isProcessAlive.mockReturnValue(false);
      vi.advanceTimersByTime(2000);
      tracker.onData('pane-1');
      vi.advanceTimersByTime(5001);

      expect(tracker.getState('pane-1')).toBe('idle');
    });

    it('clears a stale needs_me on release rather than leaving the badge lit', () => {
      // needs_me is unreachable by every heuristic, so dropping the lock alone
      // would pin the badge and the dock count until the user typed in the pane.
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'needs_me', 4242);

      isProcessAlive.mockReturnValue(false);
      vi.advanceTimersByTime(2000);

      expect(tracker.getState('pane-1')).toBe('idle');
      expect(tracker.getCounts().needsMe).toBe(0);
    });

    it('releases a pane whose shell is not one the tracker knows by name', () => {
      // The release must not depend on SHELL_NAMES: a pane running nu or xonsh
      // never looks like it is back at a prompt.
      getProcessName.mockReturnValue('nu');
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'needs_me', 4242);

      isProcessAlive.mockReturnValue(false);
      vi.advanceTimersByTime(2000);

      expect(tracker.getState('pane-1')).toBe('idle');
    });

    it('keeps the hook state while the agent process is still alive', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'working', 4242);

      vi.advanceTimersByTime(2000);
      tracker.onNeedsMe('pane-1');

      expect(tracker.getState('pane-1')).toBe('working');
    });

    it('lets a hook reporting idle clear a needs_me an earlier hook set', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'needs_me', 4242);

      tracker.setHookState('pane-1', 'idle', 4242);

      expect(tracker.getState('pane-1')).toBe('idle');
    });

    it('counts a hook needs_me pane for the OS chrome badge', () => {
      tracker.trackPane('pane-1');
      tracker.setHookState('pane-1', 'needs_me');

      expect(tracker.getCounts().needsMe).toBe(1);
    });
  });
});
