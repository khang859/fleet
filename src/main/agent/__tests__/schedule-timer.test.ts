import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleStore } from '../schedule-store';
import { SCHEDULE_TICK_MS, ScheduleTimer } from '../schedule-timer';

let dir: string;
let store: ScheduleStore;
let timer: ScheduleTimer;

beforeEach(() => {
  vi.useFakeTimers();
  // A schedule set for 9am, seen from 8am, so the first fire is an hour out.
  vi.setSystemTime(new Date(2026, 5, 1, 8, 0, 0));
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-schedule-timer-'));
  store = new ScheduleStore({ file: join(dir, 'schedules.json') });
  timer = new ScheduleTimer(store);
});

afterEach(() => {
  timer.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function create(recurring = false): void {
  store.create({
    sessionId: 'session-1',
    cwd: '/repo',
    cron: '0 9 * * *',
    note: 'Check the release job.',
    recurring,
    depth: 0,
    now: new Date()
  });
}

describe('ScheduleTimer', () => {
  it('claims nothing while nothing is due', () => {
    create();
    timer.start();
    vi.advanceTimersByTime(SCHEDULE_TICK_MS * 4);

    expect(store.list('session-1')[0].state).toBe('pending');
  });

  it('claims within a tick of the moment arriving', () => {
    create();
    timer.start();
    vi.advanceTimersByTime(60 * 60 * 1000 + 60_000);

    expect(store.list('session-1')[0].state).toBe('due');
  });

  /*
   * The whole of the app-was-closed catch-up: a schedule that came due while
   * nothing was running is found by the first tick after launch, which is the
   * same tick as every other one.
   */
  it('claims what came due while nothing was running', () => {
    create();
    timer.stop();
    vi.setSystemTime(new Date(2026, 5, 3, 10, 0, 0));

    timer.start();

    expect(store.list('session-1')[0].state).toBe('due');
  });

  it('claims a long sleep once rather than once per interval missed', () => {
    create(true);
    const claimed = vi.spyOn(store, 'claimDue');
    timer.start();
    vi.setSystemTime(new Date(2026, 5, 4, 10, 0, 0));
    vi.advanceTimersByTime(SCHEDULE_TICK_MS * 3);

    expect(claimed.mock.results.flatMap((result) => result.value)).toHaveLength(1);
  });

  it('stops asking once stopped', () => {
    create();
    const claimed = vi.spyOn(store, 'claimDue');
    timer.start();
    timer.stop();
    vi.advanceTimersByTime(SCHEDULE_TICK_MS * 10);

    // The one the eager first tick made, and nothing since.
    expect(claimed).toHaveBeenCalledTimes(1);
  });

  it('does not stack a second interval on a second start', () => {
    const claimed = vi.spyOn(store, 'claimDue');
    timer.start();
    timer.start();
    vi.advanceTimersByTime(SCHEDULE_TICK_MS);

    // The eager tick and one interval tick, not two of each.
    expect(claimed).toHaveBeenCalledTimes(2);
  });

  // One unreadable record must not take every schedule on the machine down with
  // it for the rest of the run.
  it('keeps ticking after a tick throws', () => {
    const claimed = vi.spyOn(store, 'claimDue').mockImplementationOnce(() => {
      throw new Error('disk went away');
    });
    timer.start();
    vi.advanceTimersByTime(SCHEDULE_TICK_MS * 2);

    expect(claimed).toHaveBeenCalledTimes(3);
  });
});
