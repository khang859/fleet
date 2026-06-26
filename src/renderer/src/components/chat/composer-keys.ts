/**
 * Pure keyboard contract for the chat Composer's textarea.
 *
 * Decides what a key press should do once the `/` and `@` autocomplete menus
 * have already had their chance to handle it. Kept side-effect free so the
 * IME-safety rules can be unit-tested without a DOM.
 */
export type ComposerKeyAction = 'send' | 'stop' | 'ignore';

export type ComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** `KeyboardEvent.isComposing` — true while an IME candidate is being composed. */
  isComposing: boolean;
  /** Legacy IME sentinel: some IMEs report `keyCode === 229` instead of `isComposing`. */
  keyCode: number;
  /** Whether a response is currently streaming (Escape stops it). */
  streaming: boolean;
};

/**
 * Keyboard contract:
 * - Escape while streaming → stop.
 * - Enter while composing an IME candidate → ignore (never premature-send).
 * - Cmd/Ctrl+Enter → always send.
 * - Shift+Enter → ignore (let the browser insert a newline, preserving undo history).
 * - Plain Enter → send.
 */
export function composerKeyAction(e: ComposerKeyEvent): ComposerKeyAction {
  if (e.key === 'Escape') return e.streaming ? 'stop' : 'ignore';
  if (e.key !== 'Enter') return 'ignore';
  // Never act on Enter mid-composition (CJK candidate selection, dead keys, etc.).
  if (e.isComposing || e.keyCode === 229) return 'ignore';
  if (e.metaKey || e.ctrlKey) return 'send';
  if (e.shiftKey) return 'ignore';
  return 'send';
}
