import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRON_SEARCH_LIMIT_MS, jitterMs, nextFireAfter, parseCron } from '../agent-schedule-cron';

/*
 * Everything here runs in a fixed zone, because half of what is being tested is
 * what happens on the two days a year a local clock is not a straight line. The
 * suite would otherwise pass or fail depending on where the machine running it
 * happens to be.
 */
const TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

/** The parsed expression, or a failure that names it rather than saying "null". */
function fields(expr: string): NonNullable<ReturnType<typeof parseCron>> {
  const parsed = parseCron(expr);
  if (parsed === null) throw new Error(`expected \`${expr}\` to parse`);
  return parsed;
}

/** What `nextFireAfter` gave back, as a local-time string worth reading in a diff. */
function fireAfter(expr: string, after: Date, limitMs?: number): string | null {
  const at = nextFireAfter(fields(expr), after, limitMs);
  return at === null ? null : local(at);
}

function local(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

describe('parseCron', () => {
  it('reads the every-minute expression', () => {
    const every = fields('* * * * *');

    expect(every.minutes.size).toBe(60);
    expect(every.hours.size).toBe(24);
    expect(every.daysOfMonth.size).toBe(31);
    expect(every.months.size).toBe(12);
    expect(every.daysOfWeek.size).toBe(7);
    expect(every.dayOfMonthRestricted).toBe(false);
    expect(every.dayOfWeekRestricted).toBe(false);
  });

  it('insists on exactly five fields', () => {
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
    expect(parseCron('')).toBeNull();
  });

  it('is not upset by ragged whitespace', () => {
    expect(parseCron('  0   9  *  *  * ')).not.toBeNull();
  });

  it('reads steps, ranges and lists', () => {
    expect([...fields('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...fields('5,10,15 * * * *').minutes]).toEqual([5, 10, 15]);
    expect([...fields('0 9-17/4 * * *').hours]).toEqual([9, 13, 17]);
    expect([...fields('0 0 1-3 * *').daysOfMonth]).toEqual([1, 2, 3]);
  });

  it('reads a bare value with a step as running to the end of the field', () => {
    expect([...fields('40/10 * * * *').minutes]).toEqual([40, 50]);
  });

  it('reads three-letter day and month names', () => {
    expect([...fields('0 9 * * MON-FRI').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...fields('0 0 1 jan,jul *').months]).toEqual([1, 7]);
    expect([...fields('0 0 * * sun').daysOfWeek]).toEqual([0]);
  });

  it('takes 7 as a second spelling of Sunday', () => {
    const sunday = fields('0 0 * * 7');

    expect([...sunday.daysOfWeek]).toEqual([0]);
    expect(sunday.dayOfWeekRestricted).toBe(true);
  });

  it('refuses values outside a field', () => {
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('* 24 * * *')).toBeNull();
    expect(parseCron('0 0 32 * *')).toBeNull();
    expect(parseCron('0 0 * 13 *')).toBeNull();
    expect(parseCron('0 0 * * 8')).toBeNull();
    expect(parseCron('0 0 0 * *')).toBeNull();
  });

  it('refuses malformed fields', () => {
    expect(parseCron('abc * * * *')).toBeNull();
    expect(parseCron('5-1 * * * *')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull();
    expect(parseCron('*/ * * * *')).toBeNull();
    expect(parseCron('*/2/2 * * * *')).toBeNull();
    expect(parseCron('1,,2 * * * *')).toBeNull();
    expect(parseCron('* * * * FUN')).toBeNull();
    // A name is only a name in the field that has that vocabulary.
    expect(parseCron('JAN * * * *')).toBeNull();
    expect(parseCron('0 0 * MON *')).toBeNull();
  });
});

describe('nextFireAfter', () => {
  it('finds the ordinary next occurrence', () => {
    expect(fireAfter('0 9 * * *', new Date(2026, 5, 1, 8, 0))).toBe('2026-06-01 09:00');
  });

  it('is strictly after the instant it is given', () => {
    expect(fireAfter('0 9 * * *', new Date(2026, 5, 1, 9, 0))).toBe('2026-06-02 09:00');
  });

  it('ignores seconds already elapsed in the current minute', () => {
    expect(fireAfter('*/15 * * * *', new Date(2026, 5, 1, 8, 45, 30))).toBe('2026-06-01 09:00');
  });

  it('crosses a month and a year', () => {
    expect(fireAfter('0 0 1 * *', new Date(2026, 11, 15, 0, 0))).toBe('2027-01-01 00:00');
  });

  /*
   * The rule from POSIX crontab(5) that people are most often surprised by, and
   * the reason the tool description states it outright.
   */
  describe('day-of-month versus day-of-week', () => {
    it('ORs them when both are restricted', () => {
      // Friday the 13th of November 2026 is preceded by Friday the 6th, and the
      // 13th itself is only reached because the day-of-month arm matches too.
      expect(fireAfter('0 0 13 * FRI', new Date(2026, 10, 1, 12, 0))).toBe('2026-11-06 00:00');
      expect(fireAfter('0 0 13 * FRI', new Date(2026, 10, 7, 12, 0))).toBe('2026-11-13 00:00');
      // The 20th is a Friday, so the 15th - a Sunday - is skipped even though a
      // plain day-of-month reading would have caught nothing else that week.
      expect(fireAfter('0 0 13 * FRI', new Date(2026, 10, 14, 12, 0))).toBe('2026-11-20 00:00');
    });

    it('ANDs them when only one is restricted', () => {
      // Day-of-week alone: every Friday, whatever the date.
      expect(fireAfter('0 0 * * FRI', new Date(2026, 10, 14, 12, 0))).toBe('2026-11-20 00:00');
      // Day-of-month alone: the 13th, whatever the weekday.
      expect(fireAfter('0 0 13 * *', new Date(2026, 10, 14, 12, 0))).toBe('2026-12-13 00:00');
    });
  });

  describe('daylight saving', () => {
    // Spring forward 2026 in New York: 02:00 becomes 03:00 on 8 March, so no
    // local clock ever reads 02:30 that day. A fire that could only happen then
    // does not happen, which is the only sane answer for a time that did not
    // exist - it must not silently slide to 01:30 or 03:30 either.
    it('skips a time that spring-forward deleted', () => {
      expect(fireAfter('30 2 * * *', new Date(2026, 2, 7, 12, 0))).toBe('2026-03-09 02:30');
    });

    it('still fires either side of the deleted hour', () => {
      expect(fireAfter('30 1 * * *', new Date(2026, 2, 7, 12, 0))).toBe('2026-03-08 01:30');
      expect(fireAfter('30 3 * * *', new Date(2026, 2, 7, 12, 0))).toBe('2026-03-08 03:30');
    });

    // Fall back 2026: 01:00 to 01:59 happens twice on 1 November. "Next" has
    // one answer, so it is the first of the two - the one still on daylight
    // time - and the repeat an hour later is not a second occurrence.
    it('fires once in the repeated hour, at its first real instant', () => {
      const first = nextFireAfter(fields('30 1 * * *'), new Date(2026, 9, 31, 12, 0));
      expect(first).not.toBeNull();
      if (first === null) return;

      expect(local(first)).toBe('2026-11-01 01:30');
      // Still on daylight time: the earlier of the two instants that read 01:30.
      expect(first.getTimezoneOffset()).toBe(240);

      // And the hour does not come round again the moment it repeats.
      const second = nextFireAfter(fields('30 1 * * *'), first);
      expect(second === null ? null : local(second)).toBe('2026-11-02 01:30');
    });
  });

  it('resolves a leap-day expression years out', () => {
    expect(fireAfter('0 0 29 2 *', new Date(2026, 2, 1, 0, 0))).toBe('2028-02-29 00:00');
  });

  it('gives up on an expression that can never match', () => {
    // There is no 30 February, and the search stops at its own limit rather
    // than walking forward until the heat death of the process.
    expect(fireAfter('30 2 30 2 *', new Date(2026, 5, 1, 0, 0))).toBeNull();
  });

  it('gives up when the answer lies past the limit it was given', () => {
    expect(fireAfter('0 0 29 2 *', new Date(2026, 2, 1, 0, 0), 24 * 60 * 60 * 1000)).toBeNull();
    expect(fireAfter('0 0 29 2 *', new Date(2026, 2, 1, 0, 0), CRON_SEARCH_LIMIT_MS)).toBe(
      '2028-02-29 00:00'
    );
  });

  it('answers a four-year search quickly enough to be called on a tick', () => {
    const started = performance.now();
    nextFireAfter(fields('30 2 30 2 *'), new Date(2026, 5, 1, 0, 0));

    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('jitterMs', () => {
  it('gives the same id the same offset every time', () => {
    expect(jitterMs('a2ff0b6e-0000-4000-8000-000000000000')).toBe(
      jitterMs('a2ff0b6e-0000-4000-8000-000000000000')
    );
  });

  it('stays inside one cron minute', () => {
    for (let i = 0; i < 500; i += 1) {
      const ms = jitterMs(`schedule-${i}`);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(60_000);
    }
  });

  // The whole point is that a machine holding many schedules does not wake them
  // all in the same instant, so a hash that clumped would be a silent failure.
  it('spreads ids across the window', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i += 1) buckets.add(Math.floor(jitterMs(`schedule-${i}`) / 10_000));

    expect(buckets.size).toBe(6);
  });
});
