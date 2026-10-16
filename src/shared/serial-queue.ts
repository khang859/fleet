/** Runs one task given to it. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs the tasks it is given one at a time, in the order they arrive. The
 * queue waits on a settled promise, so one failed task cannot wedge every
 * task after it, and that task's caller still sees the rejection.
 */
export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return async (task) => {
    // Both statements run before this first suspends, so two calls in the
    // same tick still queue in the order they arrived.
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
