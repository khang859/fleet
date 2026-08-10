/**
 * A cancellation token for the async work an effect starts.
 *
 * The usual closure flag - `let cancelled = false`, flipped in the effect's cleanup - is
 * correct at runtime but reads as dead code to the compiler. After the first
 * `if (cancelled) return`, TypeScript's control flow analysis narrows the variable to
 * `false` for the remainder of the function and cannot see the cleanup callback flipping
 * it, so every later check looks impossible (and `no-unnecessary-condition` says so).
 *
 * Reading the flag through a call sidesteps that: a call's result is never carried across
 * a later call, so each check is evaluated on its own, which is exactly the semantics an
 * await-and-check-again loop wants.
 */
export type Cancellation = {
  /** Flip the flag. Call from the effect's cleanup. */
  cancel: () => void;
  /** True once `cancel` has been called. Check after every await before touching state. */
  isCancelled: () => boolean;
};

export function createCancellation(): Cancellation {
  let cancelled = false;
  return {
    cancel: () => {
      cancelled = true;
    },
    isCancelled: () => cancelled
  };
}
