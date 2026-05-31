import { describe, it, expect } from 'vitest';
import { COLUMNS, DRAG_TARGETS, scheduleSummary, formatInterval } from '../kanban-utils';

describe('kanban-utils schedule helpers', () => {
  it('includes a Scheduled column that is not a drag target', () => {
    expect(COLUMNS.some((c) => c.status === 'scheduled')).toBe(true);
    expect(DRAG_TARGETS).not.toContain('scheduled');
  });

  it('formatInterval renders human units', () => {
    expect(formatInterval(30_000)).toBe('30s');
    expect(formatInterval(120_000)).toBe('2m');
    expect(formatInterval(2 * 3600_000)).toBe('2h');
    expect(formatInterval(48 * 3600_000)).toBe('2d');
  });

  it('scheduleSummary describes each kind', () => {
    expect(
      scheduleSummary({ scheduleKind: 'cron', scheduleCron: '0 9 * * *', scheduleIntervalMs: null })
    ).toBe('0 9 * * *');
    expect(
      scheduleSummary({
        scheduleKind: 'interval',
        scheduleCron: null,
        scheduleIntervalMs: 7200_000
      })
    ).toBe('every 2h');
    expect(
      scheduleSummary({ scheduleKind: 'once', scheduleCron: null, scheduleIntervalMs: null })
    ).toBe('once');
    expect(
      scheduleSummary({ scheduleKind: null, scheduleCron: null, scheduleIntervalMs: null })
    ).toBe('');
  });
});
