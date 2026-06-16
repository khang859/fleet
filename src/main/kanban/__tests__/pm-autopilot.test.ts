import { describe, expect, it, vi } from 'vitest';
import { PmAutopilot, type PmAutopilotDeps } from '../pm-autopilot';
import type { TaskEvent } from '../../../shared/kanban-types';

function evt(kind: string, taskId = 't1'): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

function makeDeps(overrides: Partial<PmAutopilotDeps> = {}) {
  let t = 0;
  const runTurn = vi.fn(async () => Promise.resolve());
  const deps: PmAutopilotDeps = {
    now: () => t,
    getConfig: () => ({ autopilotEnabled: true, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 }),
    getBoardForTask: () => 'b1',
    runTurn,
    buildBriefing: (events: TaskEvent[]) => `events: ${events.map((e) => e.kind).join(',')}`,
    log: () => {}
  };
  return { deps: { ...deps, ...overrides }, runTurn, advance: (ms: number) => (t += ms) };
}

describe('PmAutopilot event turns', () => {
  it('ignores events when autopilot is disabled', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps({
      getConfig: () => ({ autopilotEnabled: false, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 })
    });
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('completed'));
    vi.runAllTimers();
    expect(runTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('ignores non-whitelisted event kinds', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('heartbeat'));
    pa.onEvent(evt('comment'));
    vi.runAllTimers();
    expect(runTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('coalesces a burst into one turn', () => {
    vi.useFakeTimers();
    const { deps, runTurn } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('completed', 'a'));
    pa.onEvent(evt('completed', 'b'));
    pa.onEvent(evt('blocked', 'c'));
    vi.advanceTimersByTime(2_000);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith(
      'b1',
      expect.stringContaining('completed,completed,blocked'),
      'event'
    );
    vi.useRealTimers();
  });

  it('enforces the min-gap between turns', async () => {
    vi.useFakeTimers();
    const { deps, runTurn, advance } = makeDeps();
    const pa = new PmAutopilot(deps);
    pa.onEvent(evt('completed'));
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(1);

    // a second burst within the min-gap is deferred, not fired immediately
    advance(5_000); // 5s elapsed << 30s gap
    pa.onEvent(evt('blocked'));
    vi.advanceTimersByTime(2_000);
    expect(runTurn).toHaveBeenCalledTimes(1);

    // after the gap elapses it fires
    advance(30_000);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
