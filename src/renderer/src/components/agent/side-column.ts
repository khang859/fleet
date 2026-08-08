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
 * How wide the conversation reads at its widest.
 *
 * The `max-w-2xl` the transcript, the status line, the composer and the location
 * line all share, kept here because the gutter below is a sum of this and the
 * column. Tailwind owns the classes; this is the same number spelled out so the
 * arithmetic can be done in one place rather than guessed at.
 */
export const READING_COLUMN_MAX_PX = 672;

/**
 * The empty gutter on the left of the conversation, when the column is up.
 *
 * Without one, `mx-auto` centers the conversation in what the column leaves
 * behind rather than in the pane, so the composer and every line above it sit
 * half a column left of the tabs that are still centered over them. A gutter the
 * width of the column puts the two centers back together.
 *
 * Clamped rather than always the full width, because a pane can be wide enough
 * for a column and still not wide enough to be symmetric about one. Only the
 * room left over once the conversation has read at its full width is given
 * away, so a narrow pane loses the centering - which is what it looks like
 * today - rather than the reading width, which is what the pane is for.
 */
export function centeringGutterPx(width: number | null, columned: boolean): number {
  if (width === null || !columned) return 0;
  const spare = width - SIDE_COLUMN_WIDTH_PX - READING_COLUMN_MAX_PX;
  return Math.max(0, Math.min(SIDE_COLUMN_WIDTH_PX, spare));
}

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
