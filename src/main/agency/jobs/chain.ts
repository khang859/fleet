/**
 * How many automatic Admiral turns a job takes in a row before it stops and
 * asks the client whether to go on. A client action or a finished step
 * resets the count.
 */
export const CHAIN_LIMIT = 20;

/** Whether a job that took `count` automatic turns in a row must ask before the next. */
export function chainExhausted(count: number): boolean {
  return count >= CHAIN_LIMIT;
}
