import { describe, it, expect } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import {
  computeNextRun,
  validateSchedule,
  taskToScheduleInput
} from '../kanban/schedule';
import type { Task } from '../../shared/kanban-types';

describe('computeNextRun', () => {
  it('returns the fire time as-is for once', () => {
    expect(computeNextRun({ kind: 'once', at: 12345 }, 0)).toBe(12345);
  });

  it('returns after + everyMs for interval', () => {
    expect(computeNextRun({ kind: 'interval', everyMs: 1000 }, 5000)).toBe(6000);
  });

  it('schedules one period out even after a long gap (skip-missed)', () => {
    expect(computeNextRun({ kind: 'interval', everyMs: 1000 }, 999_000)).toBe(1_000_000);
  });

  it('matches cron-parser next() for cron, strictly after `after`', () => {
    const after = Date.parse('2026-01-01T00:00:00Z');
    const expected = CronExpressionParser.parse('0 0 * * *', { currentDate: new Date(after) })
      .next()
      .toDate()
      .getTime();
    const got = computeNextRun({ kind: 'cron', expr: '0 0 * * *' }, after);
    expect(got).toBe(expected);
    expect(got).toBeGreaterThan(after);
  });
});

describe('validateSchedule', () => {
  it('rejects a non-positive interval', () => {
    expect(validateSchedule({ kind: 'interval', everyMs: 0 }).ok).toBe(false);
  });
  it('accepts a positive interval', () => {
    expect(validateSchedule({ kind: 'interval', everyMs: 1000 }).ok).toBe(true);
  });
  it('rejects an invalid cron expression', () => {
    expect(validateSchedule({ kind: 'cron', expr: 'not a cron' }).ok).toBe(false);
  });
  it('accepts a valid cron expression', () => {
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }).ok).toBe(true);
  });
});

describe('taskToScheduleInput', () => {
  const base = { scheduleCron: null, scheduleIntervalMs: null, nextRunAt: null } as Partial<Task>;
  it('maps an interval task', () => {
    const t = { ...base, scheduleKind: 'interval', scheduleIntervalMs: 2000 } as Task;
    expect(taskToScheduleInput(t)).toEqual({ kind: 'interval', everyMs: 2000 });
  });
  it('maps a cron task', () => {
    const t = { ...base, scheduleKind: 'cron', scheduleCron: '0 0 * * *' } as Task;
    expect(taskToScheduleInput(t)).toEqual({ kind: 'cron', expr: '0 0 * * *' });
  });
  it('returns null for an unscheduled task', () => {
    const t = { ...base, scheduleKind: null } as Task;
    expect(taskToScheduleInput(t)).toBeNull();
  });
});
