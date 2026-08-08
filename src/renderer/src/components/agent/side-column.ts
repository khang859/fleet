/**
 * The column beside the conversation, and when the pane can afford one.
 *
 * Two cards live in it - the task list and the subagents - and they are shown
 * for quite different reasons: one because the agent wrote a plan, the other
 * because something is running. What they share is the room they need, which is
 * a fact about the pane rather than about either list. It is settled here so
 * that the two can never disagree about whether the column exists.
 */

/**
 * Pane width below which the column is not worth its room.
 *
 * A pane narrower than this has a conversation squeezed to nothing once a
 * column is taken out of it, and a transcript is what the pane is for. Chosen
 * against the transcript rather than against the cards: the reading column is
 * `max-w-2xl` (672px) plus its padding, so this is about the width at which the
 * text would start to be the thing giving way.
 */
export const SIDE_COLUMN_MIN_PANE_PX = 950;

/**
 * Width the column hangs on down to once it is already showing.
 *
 * One threshold for both directions would put a 272px column in and out of the
 * layout on every pixel of jitter while a split divider is parked on the line -
 * and the divider is dragged live, so that line is easy to park on. Below this
 * the column really is too much and goes; between the two it keeps whatever it
 * was, which is the answer that does not move under the reader.
 */
export const SIDE_COLUMN_KEEP_PX = 890;

/**
 * What the column takes when it is shown, gutters included.
 *
 * The cards float inside this rather than filling it, so a dozen or so pixels
 * of this go to the gap on either side of them and the rest is the card.
 */
export const SIDE_COLUMN_WIDTH_PX = 272;

/**
 * Whether the pane has the room, given whether the column is up now.
 *
 * Not while the width is still `null`: the first paint would put a column into
 * a pane that turns out to be half its size, and the reader would watch the
 * conversation jump sideways a frame later.
 */
export function fitsSideColumn(width: number | null, shown: boolean): boolean {
  if (width === null) return false;
  return width >= (shown ? SIDE_COLUMN_KEEP_PX : SIDE_COLUMN_MIN_PANE_PX);
}
