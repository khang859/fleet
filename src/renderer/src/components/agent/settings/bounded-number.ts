/**
 * The rule a bounded number field follows while somebody is typing into it.
 *
 * Split out from the component because the bug it exists to prevent is a rule
 * about *when*, not about rendering: a controlled `<input type="number">` that
 * clamps inside `onChange` cannot be typed into. Select `256`, type `4096`, and
 * the first `4` is clamped to the minimum on that keystroke; the remaining
 * digits then build on the replacement rather than on what was meant. Clearing
 * the field snaps to a number the moment the last digit goes.
 *
 * So there are two questions and they have different answers. What the field
 * *shows* while editing is whatever was typed, unexamined. What the field
 * *stores* is decided once, when editing ends.
 */

/** The range a committed value must land in, and what an empty field means. */
export type NumberBounds = {
  min: number;
  max: number;
  /** Used when the draft is empty or is not a number at all. */
  fallback: number;
};

/**
 * What the field shows.
 *
 * The draft wins whenever there is one, unexamined and unclamped, because it is
 * the person's and they have not finished with it. `null` means nobody is
 * editing, so the stored value is what there is to show.
 */
export function shownNumber(draft: string | null, value: number): string {
  return draft ?? String(value);
}

/**
 * What a finished draft means as a number.
 *
 * Rounded because these are all counts of something whole - tokens, fetches,
 * results - and clamped because the bounds are real limits rather than
 * suggestions. An empty field is a person saying "whichever", which is the
 * fallback rather than zero.
 */
export function commitNumber(draft: string, bounds: NumberBounds): number {
  const trimmed = draft.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
}
