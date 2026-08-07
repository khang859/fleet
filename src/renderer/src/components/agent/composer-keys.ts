/**
 * What Enter and Escape mean in the agent composer, and when a permission
 * question is allowed to appear under them.
 *
 * Both halves are the same rule seen from two sides: a key must never do
 * something the person pressing it did not mean. Enter is the send key, and on
 * a pane that is stopped on a permission question it is also the key that runs
 * the command - so what separates those two meanings has to be something the
 * user can see before they press it. And a card that lands between two
 * keystrokes is one nobody has looked at yet, whatever it says on it.
 *
 * Kept out of the component because it is the only part of the composer that
 * decides anything, and because what a wrong answer costs here - a command run
 * unread, a turn thrown away, a message that will not send - is worth being
 * able to test without a browser.
 */

/**
 * How long the composer has to be quiet before a permission question is put on
 * screen.
 *
 * A card that appears mid-sentence appears under the hands of someone whose
 * next keystroke was aimed at the message they were writing. Claude Code and
 * Codex both arrived at the same answer after the same bug reports - hold the
 * question until the typing stops - and at roughly the same delay, which is the
 * evidence for this number being about right.
 *
 * Typing is most of what counts, but not all of it: attaching a file is the
 * message being written too, and the hands doing it are on the same keyboard.
 *
 * Only before the card is drawn. Once it is up it stays up: it is the turn's
 * question, not a notification, and taking it away because the user started
 * typing again would leave the turn stopped on something they can no longer
 * answer.
 */
export const PERMISSION_DRAFT_IDLE_MS = 1000;

/**
 * How long a first Escape stays loaded before it is forgotten.
 *
 * Long enough to be a deliberate second press, short enough that an Escape hit
 * on the way past cannot still be waiting when the user comes back and presses
 * it for something else entirely.
 */
export const INTERRUPT_ARM_MS = 2000;

/**
 * How much longer the question has to wait, in milliseconds.
 *
 * Zero means it can be drawn now. Anything else is how long is left of the
 * quiet period, measured from the last change to the message being written
 * rather than from when the question arrived - so someone who keeps working on
 * it keeps pushing the question back.
 */
export function settleDelay(now: number, draftedAt: number): number {
  const idleFor = now - draftedAt;
  return idleFor >= PERMISSION_DRAFT_IDLE_MS ? 0 : PERMISSION_DRAFT_IDLE_MS - idleFor;
}

/** A key press, reduced to what the decision depends on. */
export type ComposerKey = {
  key: string;
  shiftKey: boolean;
};

/** What the composer is holding when the key arrives. */
export type ComposerState = {
  /** A permission question is on screen and waiting to be answered. */
  asking: boolean;
  /** A turn is running, so there is something an Escape could stop. */
  streaming: boolean;
  /** An Escape has already been pressed and has not yet been forgotten. */
  armed: boolean;
  /** Something is in the box - text or attached pictures, either counts. */
  draft: boolean;
};

/**
 * What the composer should do about the key.
 *
 * `pass` is everything the composer has no opinion about: the caret's keys, the
 * browser's, and Escape on a pane with nothing running. Those are left alone
 * entirely, default included.
 */
export type ComposerIntent = 'approve' | 'send' | 'arm' | 'interrupt' | 'pass';

/**
 * The one decision the composer's keyboard makes.
 *
 * Enter answers the question only with an empty box. A card can arrive in the
 * middle of a sentence someone is still writing, and Enter is how that sentence
 * gets sent - so with a draft in hand the key stays the send key it has always
 * been, and the user is told to answer above rather than having answered by
 * reflex. It is also what keeps `/clear` working while a question is up: a
 * typed-out command is a draft like any other.
 *
 * Escape takes two presses, and only while there is a turn to stop. One press
 * is too easy to arrive by accident - leaving a field, dismissing something -
 * and what it would throw away is minutes of work and the money that bought
 * them.
 *
 * The `/` and `@` menus get first refusal on the keys above this, since while
 * one is open Enter belongs to the row it has highlighted.
 */
export function composerIntent(key: ComposerKey, state: ComposerState): ComposerIntent {
  if (key.key === 'Escape') {
    if (!state.streaming) return 'pass';
    return state.armed ? 'interrupt' : 'arm';
  }
  if (key.key === 'Enter' && !key.shiftKey) {
    return state.asking && !state.draft ? 'approve' : 'send';
  }
  return 'pass';
}
