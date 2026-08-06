/**
 * The composer's `@` menu: pointing at a file in the working folder without
 * leaving the sentence you are typing.
 *
 * Anchored to the start of a word, which is the whole of what makes this
 * usable: an email address, a decorator, a handle in pasted text - all of them
 * contain an `@`, and none of them are someone asking for a file picker. A menu
 * that opened for those would be a menu the user learns to dismiss.
 */

/** A trailing `@word` at the end of what has been typed, and nothing else. */
const MENTION_RE = /(?:^|\s)@([\w./-]*)$/;

/**
 * What the menu should be searching for, or `null` when it should be closed.
 *
 * An empty string is a real answer rather than nothing: a bare `@` means "show
 * me what is here", which is the first thing anyone types.
 */
export function agentMentionQuery(text: string, dismissed: boolean): string | null {
  if (dismissed) return null;
  const match = MENTION_RE.exec(text);
  return match === null ? null : match[1];
}

/**
 * The line with the `@…` the user was typing taken out of it.
 *
 * Picking a file turns it into a chip above the composer, so leaving the token
 * behind would send the model the same file twice - once as an attachment and
 * once as a half-typed path in the middle of a sentence.
 */
export function withoutMentionQuery(text: string): string {
  return text.replace(MENTION_RE, (whole) => (whole.startsWith('@') ? '' : ' '));
}
