/**
 * When a background update check is allowed to run.
 *
 * Fleet used to check exactly once, after the first paint, which answered the
 * question for a session that lasts minutes and never again for one that lasts
 * days - and days is the normal case here, because the window holds running
 * agents and nobody closes it. At roughly one release every two to three days a
 * long-lived window falls several versions behind while reporting the answer it
 * got on the morning it was opened.
 *
 * Three things now ask for a check: a timer, the window regaining focus, and the
 * machine waking. They overlap constantly - opening a laptop lid fires the wake
 * and the focus within the same second, and the timer may well be due too - so
 * they all go through {@link shouldCheck} rather than each calling the updater.
 * The gap is what makes three triggers behave like one.
 *
 * Kept apart from `index.ts` because that file is well past a thousand lines and
 * cannot be imported on its own, and this is the part with an actual decision in
 * it. `settings-store.ts` exports `migrateLegacyScrollback` for the same reason.
 */

/** How often the timer asks, with the window left open and untouched. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * The floor between two checks, whatever asked for them.
 *
 * Shorter than the timer's period on purpose: a machine that slept through the
 * timer should get an answer when it wakes rather than waiting out a fresh four
 * hours, and half an hour is long enough that alt-tabbing does not turn into a
 * request per switch.
 */
export const MIN_CHECK_GAP_MS = 30 * 60 * 1000;

/**
 * Whether a check asked for at `now` should actually run.
 *
 * `lastCheckAt` is null before the first one, which always runs.
 */
export function shouldCheck(now: number, lastCheckAt: number | null): boolean {
  if (lastCheckAt === null) return true;
  return now - lastCheckAt >= MIN_CHECK_GAP_MS;
}
