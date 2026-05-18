import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityTracker } from '../activity-tracker';
import { EventBus } from '../event-bus';
import type { AgentId } from '../../shared/types';

describe('ActivityTracker', () => {
  let eventBus: EventBus;
  let tracker: ActivityTracker;
  let getProcessName: ReturnType<typeof vi.fn<(paneId: string) => string | undefined>>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    getProcessName = vi.fn<(paneId: string) => string | undefined>().mockReturnValue('zsh');
    tracker = new ActivityTracker(eventBus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 2000,
      getProcessName
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
});

describe('ActivityTracker agent forwarding', () => {
  it('includes agent in emitted events when setAgent has been called', () => {
    const bus = new EventBus();
    const getProcessName = vi.fn<(paneId: string) => string | undefined>().mockReturnValue('zsh');
    const tracker = new ActivityTracker(bus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 10_000,
      getProcessName
    });
    const callback = vi.fn();
    bus.on('activity-state-change', callback);

    tracker.trackPane('p1');
    tracker.setAgent('p1', 'claude' satisfies AgentId);
    tracker.onData('p1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', state: 'working', agent: 'claude' })
    );

    tracker.dispose();
  });

  it('omits agent when none set', () => {
    const bus = new EventBus();
    const getProcessName = vi.fn<(paneId: string) => string | undefined>().mockReturnValue('zsh');
    const tracker = new ActivityTracker(bus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 10_000,
      getProcessName
    });
    const callback = vi.fn();
    bus.on('activity-state-change', callback);

    tracker.trackPane('p1');
    tracker.onData('p1');

    const arg = callback.mock.calls[0][0];
    expect(arg.agent).toBeUndefined();

    tracker.dispose();
  });

  it('setAgent emits a state-change with the current state when agent changes', () => {
    const bus = new EventBus();
    const getProcessName = vi.fn<(paneId: string) => string | undefined>().mockReturnValue('zsh');
    const tracker = new ActivityTracker(bus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 10_000,
      getProcessName
    });
    const callback = vi.fn();
    bus.on('activity-state-change', callback);

    tracker.trackPane('p1');
    tracker.setAgent('p1', 'pi');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', state: 'idle', agent: 'pi' })
    );

    tracker.dispose();
  });
});
