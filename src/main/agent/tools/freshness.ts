/**
 * What the agent has looked at, and what it looked like at the time.
 *
 * An edit is a claim about a file's current contents. The claim is checked by
 * the match itself, but a match cannot catch the case that matters: the file
 * changed since the agent read it, so the lines the agent is reasoning about -
 * the ones it did not quote - are no longer there. Editing then writes a file
 * built from two different versions of the truth.
 *
 * So a file has to have been read, and has to be unchanged since. Both are one
 * extra round trip when they fail, which is the cheapest possible outcome
 * compared with a silent clobber of work the user did in their editor.
 *
 * Process-wide rather than per-thread, because the thing being tracked is the
 * file on disk, which does not care which pane is looking at it.
 */

type Stamp = { mtimeMs: number; size: number };

const seen = new Map<string, Stamp>();

/** Record what a file looked like when the agent read or wrote it. */
export function remember(abs: string, stamp: Stamp): void {
  seen.set(abs, { mtimeMs: stamp.mtimeMs, size: stamp.size });
}

/**
 * Throw unless the agent has read this file and it has not changed since.
 * The message is what the model reads, so it says what to do next.
 */
export function requireFresh(abs: string, current: Stamp, shown: string): void {
  const stamp = seen.get(abs);
  if (stamp === undefined) {
    throw new Error(
      `Read ${shown} before changing it, so the change is based on what is there now`
    );
  }
  if (stamp.mtimeMs !== current.mtimeMs || stamp.size !== current.size) {
    throw new Error(`${shown} changed on disk since you read it - read it again first`);
  }
}

/** Test seam: forget every file, as though the app had just started. */
export function forgetAllFiles(): void {
  seen.clear();
}
