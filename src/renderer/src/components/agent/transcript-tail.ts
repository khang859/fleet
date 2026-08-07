/**
 * Whether the transcript is still showing its own end.
 *
 * Following a stream is two questions, and confusing them is what leaves the
 * newest thing on screen sitting just below the fold: where the reader put
 * themselves, and whether the box has since stopped showing them that place.
 */

/** How near the end still counts as being at it, in pixels. */
export const TAIL_SLACK_PX = 24;

/** A scroll box's measurements, as the DOM reports them. */
export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/**
 * Whether the reader is parked at the end of the transcript.
 *
 * A line's worth of slack, so "as far down as it goes" survives the fractional
 * scroll heights a zoomed or half-pixel layout produces.
 */
export function atTail(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= TAIL_SLACK_PX;
}

/** The two heights that decide whether the end of the transcript moved out of view. */
export type Room = {
  /** How tall the transcript's content is. */
  content: number;
  /** How tall the window onto it is. */
  port: number;
};

/**
 * Whether the end of the transcript has just been pushed below the fold.
 *
 * Content growing is the obvious half: a reply keeps arriving, and a code block
 * highlighted asynchronously lands taller than the space held for it.
 *
 * The window shrinking is the same thing happening from the other side, and is
 * the half that is easy to miss. A line appearing *under* the transcript - a
 * permission question's status line, an error, the composer growing under a
 * long draft - takes its space out of this box without changing anything
 * inside it. Nothing scrolls, so nothing fires, and what quietly slips out of
 * sight is whatever just arrived: the answer, or the buttons that answer a
 * question.
 */
export function lostRoom(before: Room, after: Room): boolean {
  return after.content > before.content || after.port < before.port;
}
