/**
 * A 5-field cron expression, and when it next comes round.
 *
 * Written here rather than taken from a package because the dialect this needs
 * is small and the one every library ships is not. `*`, `,`, `-`, `/` and
 * 3-letter names is the whole of what the tool description promises; the
 * libraries worth reaching for add either an IANA timezone database, which this
 * deliberately does not want, or seconds fields and `L`/`W`/`#`/`@daily`, which
 * the description would then have to either document or suppress.
 *
 * Everything here reads the machine's own local wall clock through `Date`'s
 * local getters, because "the user's timezone" is the promise being kept and no
 * offset is stored anywhere. A schedule carried across a timezone change means
 * 9am wherever the user now is, which is the only honest reading of a wall-clock
 * cron.
 */

/** Sunday first, matching `Date.prototype.getDay`. */
const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12
};

/**
 * How far forward a search will look before giving up.
 *
 * Four years rather than one, because `0 0 29 2 *` is a legal expression that
 * only comes round on a leap year and refusing it would be wrong. Four covers
 * every leap year and still terminates on an expression such as `30 2 30 2 *`,
 * which can never match at all.
 */
export const CRON_SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * 60 * 1000;

/** The window jitter is spread over: under one cron minute, by construction. */
const JITTER_WINDOW_MS = 60_000;

/**
 * One parsed expression: which values of each field match.
 *
 * The two `restricted` flags exist for the one cron rule that reliably
 * surprises people. Day-of-month and day-of-week are OR'd when both are
 * restricted and AND'd otherwise, so the sets alone cannot say what a match
 * means - `*` expands to every value, and every-value is indistinguishable from
 * a range that happens to cover everything once it is a set.
 */
export type CronFields = {
  /** 0-59 */
  minutes: ReadonlySet<number>;
  /** 0-23 */
  hours: ReadonlySet<number>;
  /** 1-31 */
  daysOfMonth: ReadonlySet<number>;
  /** 1-12 */
  months: ReadonlySet<number>;
  /** 0-6, Sunday first. `7` is accepted on the way in and normalized to `0`. */
  daysOfWeek: ReadonlySet<number>;
  /** Whether the day-of-month field was written as something other than `*`. */
  dayOfMonthRestricted: boolean;
  /** Whether the day-of-week field was written as something other than `*`. */
  dayOfWeekRestricted: boolean;
};

/**
 * Read an expression, or `null` if it is not one.
 *
 * Null rather than a throw because every caller has something better to say
 * than the parser does: `create` turns it into a sentence naming the field the
 * model got wrong, and nothing else parses cron at all.
 */
export function parseCron(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minutes = parseField(minute, 0, 59, null);
  const hours = parseField(hour, 0, 23, null);
  const daysOfMonth = parseField(dayOfMonth, 1, 31, null);
  const months = parseField(month, 1, 12, MONTH_NAMES);
  // 7 is allowed as a second spelling of Sunday, which is why the ceiling here
  // is one past the range the matcher actually sees.
  const daysOfWeek = parseField(dayOfWeek, 0, 7, DAY_NAMES);
  if (
    minutes === null ||
    hours === null ||
    daysOfMonth === null ||
    months === null ||
    daysOfWeek === null
  ) {
    return null;
  }

  if (daysOfWeek.delete(7)) daysOfWeek.add(0);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: dayOfMonth !== '*',
    dayOfWeekRestricted: dayOfWeek !== '*'
  };
}

/**
 * The first minute strictly after `after` that the expression matches, or
 * `null` if there is none within the search limit.
 *
 * A brute-force forward walk in local time rather than field arithmetic.
 * Closed-form next-occurrence maths is where subtle date bugs live, and this
 * function decides whether a user's reminder fires at all; a walk that skips
 * whole days and hours it cannot match costs a few thousand comparisons for
 * even a leap-day expression, which is not worth being clever about.
 *
 * Daylight saving falls out of the walk rather than being handled. The search
 * never asserts that a wall-clock time it constructed still reads as itself, so
 * on spring-forward the step into the nonexistent hour normalizes past it and
 * those minutes are simply never tested - a time that did not happen cannot
 * fire. On fall-back the step out of the repeated hour lands in the second,
 * later copy, so the repeated minutes are visited once, at their first real
 * instant, which is what "next" means.
 */
export function nextFireAfter(
  fields: CronFields,
  after: Date,
  limitMs: number = CRON_SEARCH_LIMIT_MS
): Date | null {
  const limit = after.getTime() + limitMs;
  const at = new Date(after.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  while (at.getTime() <= limit) {
    const before = at.getTime();

    if (!matchesDay(fields, at)) {
      at.setHours(24, 0, 0, 0);
    } else if (!fields.hours.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
    } else if (fields.minutes.has(at.getMinutes())) {
      return new Date(at.getTime());
    } else {
      at.setMinutes(at.getMinutes() + 1);
    }

    // Every step above is written to move forward in local time, and a local
    // clock that goes backwards over a transition would otherwise mean a main
    // process that never returns. Cheaper to prove it here than to reason about
    // every zone that has ever existed.
    if (at.getTime() <= before) return null;
  }

  return null;
}

/**
 * A fixed offset within the matched minute, derived from the schedule's own id.
 *
 * Deterministic so that a daily 9am schedule fires at a consistent 9:00:0XX
 * rather than wandering by a few seconds each day, and spread so that a machine
 * holding a dozen `0 * * * *` schedules does not wake them all in the same
 * instant. FNV-1a because it is four lines and its low bits are well mixed,
 * which is the whole requirement.
 */
export function jitterMs(scheduleId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < scheduleId.length; i += 1) {
    hash ^= scheduleId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % JITTER_WINDOW_MS;
}

/**
 * The day rule, including the OR quirk.
 *
 * When only one of the two day fields is restricted the other is `*` and so
 * matches everything, which makes the `&&` below collapse to the restricted one
 * on its own. That is why the flags are only consulted for the both-restricted
 * case: the general rule already handles the rest.
 */
function matchesDay(fields: CronFields, at: Date): boolean {
  if (!fields.months.has(at.getMonth() + 1)) return false;

  const dayOfMonth = fields.daysOfMonth.has(at.getDate());
  const dayOfWeek = fields.daysOfWeek.has(at.getDay());
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek;
  }
  return dayOfMonth && dayOfWeek;
}

/**
 * One comma-separated field, expanded into the values it matches, or `null` if
 * any part of it is not a field at all.
 */
function parseField(
  spec: string,
  min: number,
  max: number,
  names: Record<string, number> | null
): Set<number> | null {
  const values = new Set<number>();

  for (const part of spec.split(',')) {
    // Cut on the first slash rather than destructuring the split, so a part
    // with two of them fails the digits test below rather than needing its own
    // check - and so the absence of a step is `null` rather than a hole the
    // types say cannot be there.
    const slash = part.indexOf('/');
    const range = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? null : part.slice(slash + 1);

    let by = 1;
    if (step !== null) {
      if (!/^\d+$/.test(step)) return null;
      by = Number(step);
      if (by < 1) return null;
    }

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else {
      const bounds = range.split('-');
      if (bounds.length === 1) {
        const only = parseValue(bounds[0], names);
        if (only === null) return null;
        from = only;
        // A bare value with a step reads as "from here to the end of the
        // field", the traditional reading of `5/15`.
        to = step === null ? only : max;
      } else if (bounds.length === 2) {
        const start = parseValue(bounds[0], names);
        const end = parseValue(bounds[1], names);
        if (start === null || end === null) return null;
        from = start;
        to = end;
      } else {
        return null;
      }
    }

    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += by) values.add(value);
  }

  return values;
}

/** One number, or one 3-letter name in the field's own vocabulary. */
function parseValue(token: string, names: Record<string, number> | null): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (names === null) return null;
  const name = token.toUpperCase();
  return Object.hasOwn(names, name) ? names[name] : null;
}
