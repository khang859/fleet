/**
 * What a conversation has looked at, and what it looked like at the time.
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
 * Recorded per conversation, because that is the scope the question belongs to.
 * A file another pane read is not a file this model has seen, so a record
 * shared between panes would let one pane's reading vouch for another pane's
 * edits - and worse, would let a pane edit a file that a second pane rewrote in
 * between, since the shared stamp would have moved with the rewrite.
 *
 * Nothing here survives a restart, so a conversation reopened tomorrow reads
 * again before it edits. That is the right direction to fail in: the file may
 * have changed while the app was closed, and this has no record either way.
 */

type Stamp = { mtimeMs: number; size: number };

/**
 * Conversation, then file. Nested rather than keyed by the two joined into one
 * string, because both halves are free-form and any separator one of them might
 * contain is a collision waiting to be found.
 */
const seen = new Map<string, Map<string, Stamp>>();

/** Record what a file looked like when this conversation read or wrote it. */
export function remember(threadId: string, abs: string, stamp: Stamp): void {
  const files = seen.get(threadId) ?? new Map<string, Stamp>();
  files.set(abs, { mtimeMs: stamp.mtimeMs, size: stamp.size });
  seen.set(threadId, files);
}

/**
 * Throw unless this conversation has read the file and it has not changed
 * since. The message is what the model reads, so it says what to do next.
 */
export function requireFresh(threadId: string, abs: string, current: Stamp, shown: string): void {
  const stamp = seen.get(threadId)?.get(abs);
  if (stamp === undefined) {
    throw new Error(
      `Read ${shown} before changing it, so the change is based on what is there now`
    );
  }
  if (stamp.mtimeMs !== current.mtimeMs || stamp.size !== current.size) {
    throw new Error(`${shown} changed on disk since you read it - read it again first`);
  }
}

/** Test seam: forget everything, as though the app had just started. */
export function forgetAllFiles(): void {
  seen.clear();
}
