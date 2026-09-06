/**
 * The rule a list-of-lines field follows while somebody is typing into it.
 *
 * Same shape of bug as the bounded number next door, and the same cause: a
 * controlled textarea whose `onChange` normalises what it was given cannot be
 * typed into. Type `first.example`, press Enter, and the trailing blank line is
 * filtered out and the newline never appears - so the next host is appended to
 * the first one and the list can only ever hold one entry. Pasting a whole list
 * happens to work, which is what hides it.
 *
 * So the draft is the raw text and stays raw until editing ends. Splitting,
 * trimming and dropping blank lines all happen once, on the way out.
 */

/** What the field shows: the raw draft while editing, the stored list otherwise. */
export function shownLines(draft: string | null, value: string[]): string {
  return draft ?? value.join('\n');
}

/**
 * What a finished draft means as a list.
 *
 * Blank lines go, so a trailing newline does not become an entry that matches
 * nothing, and surrounding space goes with them - a host pasted out of a
 * config file arrives with both.
 */
export function commitLines(draft: string): string[] {
  return draft
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
