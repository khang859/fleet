import type { ScheduleStore } from './schedule-store';
import { createLogger } from '../logger';

const log = createLogger('agent:schedules');

/**
 * How often the clock is read.
 *
 * Well under cron's one-minute granularity and under the jitter window, so a
 * schedule is claimed inside the minute it names. There is no cost to it worth
 * counting: a tick with nothing due is a comparison per pending schedule.
 */
export const SCHEDULE_TICK_MS = 15_000;

/**
 * The thing that asks, over and over, whether anything is due.
 *
 * An interval that recomputes from the wall clock rather than a `setTimeout`
 * armed for the delay, and that difference is the whole reason this class exists
 * as something other than one line. A timer armed for five hours before a laptop
 * sleeps is not guaranteed to fire on time after it wakes - Chromium throttles
 * and coalesces timers and the OS may deliver the callback late or not until
 * something else happens. An interval that asks `what is due now` every fifteen
 * seconds does not care whether fifteen seconds or five hours of real time went
 * past since the last time it asked.
 *
 * `start` ticks once immediately, and that single line is the whole of the
 * app-was-closed catch-up. There is no separate scan of overdue schedules to
 * keep in step with the live one: the first tick after launch finds them exactly
 * as the ten thousandth tick of a long-running app would.
 */
export class ScheduleTimer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly schedules: ScheduleStore) {}

  start(): void {
    if (this.timer !== null) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), SCHEDULE_TICK_MS);
    // Nothing here holds the app open. A pending schedule is not a reason to
    // keep a process alive that has otherwise finished.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One reading of the clock.
   *
   * Claiming is all that happens here, and it is deliberate that nothing else
   * can: a claimed fire spends no tokens and starts no turn until a renderer
   * pane collects it. An app running with nobody looking at the session simply
   * accumulates one claimed record, which is what makes "nothing runs while no
   * pane is open" true by construction rather than by a check somewhere.
   */
  private tick(): void {
    try {
      const claimed = this.schedules.claimDue(new Date());
      if (claimed.length > 0) {
        log.info(`${claimed.length} schedule(s) came due`, { ids: claimed.map((r) => r.id) });
      }
    } catch (err) {
      // A tick that throws must not take the interval down with it, or one bad
      // record would stop every schedule on the machine for the rest of the run.
      log.warn('schedule tick failed', err);
    }
  }
}
