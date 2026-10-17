/**
 * How long a wakeup waits after a failed Admiral turn before it may run
 * again, by how many times it has failed. Past the last step it keeps the
 * last wait, so a model that stays down is tried every two minutes rather
 * than hammered or forgotten.
 */
export const WAKEUP_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000];

/**
 * Failures after which the client is told: a "cannot reach its model" card
 * goes up and the job waits. The wakeups stay queued and keep retrying on the
 * last step until the card's Retry, or a turn that goes through.
 */
export const WAKEUP_GIVE_UP_ATTEMPTS = WAKEUP_BACKOFF_MS.length;

/**
 * A claim older than this belongs to a turn that is not coming back - the
 * renderer reloaded or crashed mid-turn - so its wakeups are handed out again.
 */
export const WAKEUP_STALE_CLAIM_MS = 10 * 60_000;

/** The wait before the next try, after `attempts` failures (1 or more). */
export function wakeupBackoffMs(attempts: number): number {
  const step = Math.min(Math.max(attempts, 1), WAKEUP_BACKOFF_MS.length) - 1;
  return WAKEUP_BACKOFF_MS[step] ?? 0;
}
