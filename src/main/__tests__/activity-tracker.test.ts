import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityTracker } from '../activity-tracker';
import { EventBus } from '../event-bus';

describe('ActivityTracker', () => {
  let eventBus: EventBus;
  let tracker: ActivityTracker;
  let getProcessName: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    getProcessName = vi.fn().mockReturnValue('zsh');
    tracker = new ActivityTracker(eventBus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 2000,
      getProcessName,
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
        state: 'working',
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
        state: 'idle',
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
    expect(callback).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' })
    );

    vi.advanceTimersByTime(1000); // now 5s after reset
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' })
    );
  });

  it('transitions to done on process exit code 0', () => {
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('pane-1');
    tracker.onExit('pane-1', 0);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: 'pane-1',
        state: 'done',
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
        state: 'error',
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
        state: 'needs_me',
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
        state: 'needs_me',
      })
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
    const workingCalls = callback.mock.calls.filter(
      (c) => c[0].state === 'working'
    );
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

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'idle' })
    );
  });
});
