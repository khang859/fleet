import { CronExpressionParser } from 'cron-parser';
import type { Task, ScheduleInput } from '../../shared/kanban-types';

export type { ScheduleInput };

/** Validates a schedule input. Rejects non-positive intervals and invalid cron. */
export function validateSchedule(
  input: ScheduleInput
): { ok: true } | { ok: false; error: string } {
  if (input.kind === 'once') {
    if (!Number.isFinite(input.at)) return { ok: false, error: 'invalid date' };
    return { ok: true };
  }
  if (input.kind === 'interval') {
    if (!Number.isFinite(input.everyMs) || input.everyMs <= 0) {
      return { ok: false, error: 'interval must be greater than zero' };
    }
    return { ok: true };
  }
  try {
    CronExpressionParser.parse(input.expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid cron expression' };
  }
}

/**
 * Next fire strictly after `after` (epoch ms).
 * - once: the fixed fire time.
 * - interval: `after + everyMs` (always one period out — naturally skip-missed).
 * - cron: cron-parser's next() seeded at `after`.
 */
export function computeNextRun(input: ScheduleInput, after: number): number {
  if (input.kind === 'once') return input.at;
  if (input.kind === 'interval') return after + input.everyMs;
  const interval = CronExpressionParser.parse(input.expr, { currentDate: new Date(after) });
  return interval.next().toDate().getTime();
}

/** Reconstructs a recurring ScheduleInput from a task's columns (null if not recurring). */
export function taskToScheduleInput(task: Task): ScheduleInput | null {
  switch (task.scheduleKind) {
    case 'once':
      return task.nextRunAt != null ? { kind: 'once', at: task.nextRunAt } : null;
    case 'interval':
      return task.scheduleIntervalMs != null
        ? { kind: 'interval', everyMs: task.scheduleIntervalMs }
        : null;
    case 'cron':
      return task.scheduleCron != null ? { kind: 'cron', expr: task.scheduleCron } : null;
    default:
      return null;
  }
}
