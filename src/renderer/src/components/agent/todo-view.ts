import {
  activeItem,
  hasOpenWork,
  isSettled,
  settledCount,
  type AgentTodoItem
} from '../../../../shared/agent-todos';

/**
 * What the task list looks like, worked out apart from what draws it.
 *
 * Two places show the same list and have to agree about it: a column beside the
 * conversation when the pane is wide, and one line above the composer when it is
 * not. Both answer the same three questions - how far along, what is happening
 * now, and is there anything to show at all - so they answer them here rather
 * than each in their own JSX.
 */

/**
 * Pane width below which the list gives up its column.
 *
 * A pane narrower than this has a conversation squeezed to nothing once a
 * column is taken out of it, and a transcript is what the pane is for. Chosen
 * against the transcript rather than against the panel: the reading column is
 * `max-w-2xl` (672px) plus its padding, so this is about the width at which the
 * text would start to be the thing giving way.
 */
export const TODO_PANEL_MIN_PANE_PX = 950;

/**
 * Width the panel hangs on down to once it is already showing.
 *
 * One threshold for both directions would put a 260px column in and out of the
 * layout on every pixel of jitter while a split divider is parked on the line -
 * and the divider is dragged live, so that line is easy to park on. Below this
 * the column really is too much and goes; between the two it keeps whatever it
 * was, which is the answer that does not move under the reader.
 */
export const TODO_PANEL_KEEP_PX = 890;

/**
 * What the panel's column takes when it is shown, gutters included.
 *
 * The card floats inside this rather than filling it, so a dozen or so pixels
 * of this go to the gap on either side of it and the rest is the card.
 */
export const TODO_PANEL_WIDTH_PX = 272;

/**
 * Finished items past which the panel shows them as one line.
 *
 * Not zero: early on, the finished pile is short and is the evidence that the
 * agent is getting somewhere, which is half of what the panel is for. It stops
 * being that once it is long enough to push the work still to do off the
 * bottom of the column.
 */
export const TODO_DONE_COLLAPSE_AT = 5;

export type TodoProgress = {
  done: number;
  total: number;
  /** `3/7`, the whole of what the collapsed form has room to say. */
  count: string;
  /**
   * The item being worked on, said in the present continuous where the model
   * gave one. `null` when nothing is running, which is an honest state rather
   * than a gap: between finishing one item and starting the next there is
   * genuinely nothing to name.
   */
  doing: string | null;
  /** Whether anything is still waiting to be done. */
  open: boolean;
};

export function todoProgress(items: AgentTodoItem[]): TodoProgress | null {
  if (items.length === 0) return null;

  const active = activeItem(items);
  const done = settledCount(items);
  return {
    done,
    total: items.length,
    count: `${done}/${items.length}`,
    // `content` when the model wrote no present-continuous form. Reading
    // "Move the parser" where "Moving the parser" belongs is a small wrongness;
    // showing nothing at all while the agent is plainly working is a bigger one.
    doing: active === null ? null : (active.activeForm ?? active.content),
    open: hasOpenWork(items)
  };
}

/**
 * The list as the column shows it: what is still to do, then what is finished.
 *
 * Display only. The stored list stays in creation order, because that is the
 * order its ids are in - a model handed `7. 1. 2. 9.` has every reason to
 * answer about the second line rather than about item 2, and would be right to
 * think the numbering was telling it something. So the reordering stops at the
 * edge of the renderer, and `renderTodoBrief` keeps the wire in creation order.
 *
 * Within each group, creation order again, which `filter` preserves for free.
 * Never completion order: a pile that re-sorts itself as things finish is a
 * pile that has to be re-read, and the plan is the more useful chronology.
 */
export function splitTodos(items: AgentTodoItem[]): {
  /** What is left, the running item first - the answer to "what now". */
  open: AgentTodoItem[];
  /** Finished and abandoned together: settled is settled, and the mark says which. */
  done: AgentTodoItem[];
} {
  return {
    open: [
      ...items.filter((item) => item.status === 'in_progress'),
      ...items.filter((item) => item.status === 'pending')
    ],
    done: items.filter(isSettled)
  };
}

/**
 * Whether the panel gets its column.
 *
 * Three ways to lose it. There is nothing to show; the pane is too narrow, at
 * which point the status line's chip says the same thing in one line; or the
 * work is done and the turn is over, which is the one worth explaining.
 *
 * A list with every item settled has said what it had to say. Holding a column
 * open for it would spend the rest of the conversation showing a plan the user
 * has finished reading - so it collapses to the chip, which still carries the
 * count as a receipt. Not the moment the last item ticks, though: finishing the
 * list and then adding to it is ordinary mid-turn behaviour, and a column that
 * vanished and came back seconds later would take the reader's eye with it both
 * times. It waits for the turn to end.
 *
 * Not while the width is still `null` either: the first paint would put a
 * column into a pane that turns out to be half its size, and the reader would
 * watch the conversation jump sideways a frame later.
 */
export function showTodoPanel(
  items: AgentTodoItem[],
  pane: {
    width: number | null;
    /** Whether a turn is running, which is what makes a finished list still live. */
    streaming: boolean;
    /** Whether the column is up now, which is what the two widths are about. */
    shown: boolean;
  }
): boolean {
  if (items.length === 0) return false;
  if (!hasOpenWork(items) && !pane.streaming) return false;
  if (pane.width === null) return false;
  return pane.width >= (pane.shown ? TODO_PANEL_KEEP_PX : TODO_PANEL_MIN_PANE_PX);
}
