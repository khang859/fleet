/**
 * Holding Backspace through a long prompt, a word at a time.
 *
 * At the usual key repeat of about 30ms, an 850-character prompt takes some 25
 * seconds of holding to clear one character per repeat - Claude Code keeps up
 * with every one of them, so the wait is all keystrokes, not lag. Once the key
 * has been held for a while, each repeat deletes a word instead, which is what
 * iOS does with its Delete key.
 *
 * Measured from the first press rather than counted in repeats, so the switch
 * comes at the same moment whatever the OS repeat rate is set to. A typo is
 * fixed well inside that second, one character at a time as before.
 */
export const HOLD_WORDS_AFTER_MS = 1000;

/** A key event, reduced to what the decision depends on. */
export type HoldKey = Pick<
  KeyboardEvent,
  | 'type'
  | 'key'
  | 'repeat'
  | 'timeStamp'
  | 'altKey'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'isComposing'
>;

/**
 * A tracker for one held Backspace. Feed it the key events the surface sees;
 * it answers whether this one is a repeat of a Backspace held long enough to
 * delete a word. Anything other than a bare Backspace keydown ends the hold,
 * so a modifier, an IME composition, a different key or a keyup can never be
 * read as part of one.
 */
export function createBackspaceHold(): (event: HoldKey) => boolean {
  // When the Backspace being held was first pressed; null while none is.
  let since: number | null = null;
  return (event) => {
    const bare =
      event.type === 'keydown' &&
      event.key === 'Backspace' &&
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey;
    if (!bare) {
      since = null;
      return false;
    }
    // A fresh press starts the clock, and so does a repeat arriving with no
    // press seen - focus moved here mid-hold, and the hold starts now. An OS
    // that misreports `repeat` as false only ever lands here, which is the
    // one-character delete it would have had anyway.
    if (!event.repeat || since === null) {
      since = event.timeStamp;
      return false;
    }
    return event.timeStamp - since >= HOLD_WORDS_AFTER_MS;
  };
}

/**
 * What Claude Code reads as "delete the previous word": ESC DEL, the bytes
 * xterm.js sends for Option+Delete on macOS and Alt+Backspace elsewhere.
 * Prefixed with ESC, which is the one shape of modified key that survives the
 * Windows ConPTY input path to a Node CLI.
 */
export const DELETE_WORD_BACKWARD = '\x1b\x7f';

/**
 * Ctrl+Backspace on Linux, which xterm.js sends as ^H and Claude Code reads as
 * one character. On Windows Claude Code already reads ^H as the word delete,
 * and on macOS the word key is Option+Delete, which xterm already sends as
 * {@link DELETE_WORD_BACKWARD}.
 */
export function isLinuxCtrlBackspace(event: HoldKey, platform: string): boolean {
  return (
    platform === 'linux' &&
    event.type === 'keydown' &&
    event.key === 'Backspace' &&
    !event.isComposing &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}
