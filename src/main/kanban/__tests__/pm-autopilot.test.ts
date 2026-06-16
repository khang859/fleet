import { afterEach, describe, expect, it, vi } from 'vitest';
import { PmAutopilot, isCronDue, type PmAutopilotDeps } from '../pm-autopilot';
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

    // after the gap elapses it fires. Both clocks must move: advance() moves the
    // manual clock that deps.now() reads (the min-gap watermark), while
    // vi.advanceTimersByTime() drives setTimeout scheduling — together they fire
    // the deferred gap-timer AND satisfy the now() >= nextAllowedAt check.
    advance(30_000);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('PmAutopilot digest', () => {
  it('fires a digest turn when cron is due and stamps the watermark', async () => {
    const runTurn = vi.fn(async () => Promise.resolve());
    const stamp = vi.fn();
    const pa = new PmAutopilot({
      now: () => 0,
      getConfig: () => ({ autopilotEnabled: true, eventMinGapMs: 30_000, coalesceWindowMs: 2_000 }),
      getBoardForTask: () => 'b1',
      runTurn,
      buildBriefing: () => 'x',
      log: () => {},
      listDigestBoards: () => [{ boardId: 'b1', digestCron: '* * * * *', lastDigestAt: null }],
      buildDigest: () => 'standup please',
      stampDigest: stamp
    });
    await pa.checkDigests();
    expect(runTurn).toHaveBeenCalledWith('b1', 'standup please', 'digest');
    expect(stamp).toHaveBeenCalledWith('b1');
  });

  it('does not fire when autopilot is disabled', async () => {
    const runTurn = vi.fn(async () => Promise.resolve());
    const pa = new PmAutopilot({
      now: () => 0,
      getConfig: () => ({
        autopilotEnabled: false,
        eventMinGapMs: 30_000,
        coalesceWindowMs: 2_000
      }),
      getBoardForTask: () => 'b1',
      runTurn,
      buildBriefing: () => 'x',
      log: () => {},
      listDigestBoards: () => [{ boardId: 'b1', digestCron: '* * * * *', lastDigestAt: null }],
      buildDigest: () => 'standup please',
      stampDigest: () => {}
    });
    await pa.checkDigests();
    expect(runTurn).not.toHaveBeenCalled();
  });

  describe('isCronDue', () => {
    it('treats a null watermark as due for an every-minute cron', () => {
      expect(isCronDue('* * * * *', null, 0)).toBe(true);
    });

    it('is not due when the next fire is still ahead of now', () => {
      // last ran at t=0; an hourly cron next fires at +1h, which is after now=+1min.
      const minute = 60_000;
      expect(isCronDue('0 * * * *', 0, minute)).toBe(false);
    });

    it('is due once the cron boundary has passed since the watermark', () => {
      const hour = 60 * 60 * 1000;
      // last ran at t=0; an hourly cron next fires at +1h; now is +2h → due.
      expect(isCronDue('0 * * * *', 0, 2 * hour)).toBe(true);
    });
  });
});
