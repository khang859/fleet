/**
 * The task list the agent keeps for itself while it works.
 *
 * A list of what a piece of work breaks into, written by the model, shown to
 * the user, and handed back to the model on every round so it cannot forget
 * what it set out to do. That last part is the whole feature: a list written
 * once and never looked at again is not a plan, it is a note the model left
 * itself and then scrolled past.
 *
 * Everything here is a pure function over a list of items. Nothing reads the
 * disk, talks to a provider or touches React, so the part of this feature that
 * decides whether the agent is drifting can be tested on its own - which
 * matters, because it is the part that is hard to be sure about by looking.
 */

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type AgentTodoStatus = (typeof TODO_STATUSES)[number];

/**
 * One item on the list.
 *
 * `content` is the imperative form - what is to be done - and `activeForm` is
 * the same thing said in the present continuous, which is what the pane shows
 * while the item is the one being worked on. Two forms rather than one because
 * a status line reading "Wire the reducer…" is a sentence about nothing,
 * whereas "Wiring the reducer…" is a sentence about right now. It is optional:
 * a model that does not write one gets `content` in the status line instead,
 * which is worse but never wrong.
 */
export type AgentTodoItem = {
  /** Minted when the item is added, and never reused. Small, because the model has to type it back. */
  id: string;
  content: string;
  activeForm: string | null;
  status: AgentTodoStatus;
};

/**
 * Items one `todo_add` may add at once, and the most a list may hold *open* at
 * once.
 *
 * Counted against open work rather than against the whole list, because nothing
 * is ever removed. A cap on the total is a cap on how much a session may ever
 * get through: a list of fifty finished items would refuse to accept a
 * fifty-first, and the only advice worth giving - finish what is on it - would
 * free nothing, so the model would be told to do the one thing that cannot
 * help. Against open work the same limit means what it sounds like, which is
 * that a plan should be a plan and not a backlog, and a session recovers from
 * it by doing the work.
 */
export const TODO_MAX_ITEMS = 50;

/**
 * List length past which the model is shown finished work in summary.
 *
 * Under this everything is printed, because the whole list is short enough that
 * summarizing it saves nothing worth the loss. Over it, a run of settled items
 * becomes one line - see `renderTodoBrief`.
 */
export const TODO_BRIEF_AT = 12;

/**
 * Rounds a list may sit unchanged before the agent is told about it, and before
 * it is told more firmly.
 *
 * Counted in rounds rather than in turns because a turn is now allowed to run
 * as long as it likes - the drift this exists to catch happens forty rounds
 * deep inside one request, not between two of them. Six is chosen to be longer
 * than a real item takes: reading a file, changing it, running the tests and
 * fixing what they say is four or five rounds of honest work on one item, and
 * being nagged in the middle of that would teach the model to update the list
 * to stop the nagging, which is the exact behaviour this is trying to prevent.
 */
export const TODO_NUDGE_AT = 6;
export const TODO_ESCALATE_AT = 14;

/**
 * How often the firmest rung may be said again once it has been said.
 *
 * The rung above it is a demand to stop and fix the list before anything else,
 * and it was being made on every round for as long as the streak lasted. That
 * turns out to be self-defeating in a way the gentler rungs are not: answering
 * it costs the model the round it would have spent finishing the item, so
 * nothing settles, so the streak grows, so it is asked again - harder - the
 * next round. A real session was observed spending twenty consecutive rounds
 * explaining why its list had not moved instead of moving it.
 *
 * So it is said once and then not again for a while. The list itself is still
 * shown every round, and the mild rung still rides with it; what backs off is
 * only the instruction to drop everything, which has already been given and
 * either landed or did not. Ten rounds is enough to finish something large
 * enough to have caused the streak in the first place.
 */
export const TODO_ESCALATE_EVERY = 10;

/**
 * Whether an item is finished with, one way or the other.
 *
 * The one place the difference between "done" and "not done" is decided, so
 * the count in the pane, the cap on the list and what the model is shown in
 * summary can never disagree about which items those are.
 */
export function isSettled(item: AgentTodoItem): boolean {
  return item.status === 'completed' || item.status === 'cancelled';
}

/** Whether anything on the list is still waiting to be done. */
export function hasOpenWork(items: AgentTodoItem[]): boolean {
  return items.some((item) => !isSettled(item));
}

/** The item being worked on, or `null`. There is only ever one - see `oneInProgress`. */
export function activeItem(items: AgentTodoItem[]): AgentTodoItem | null {
  return items.find((item) => item.status === 'in_progress') ?? null;
}

/** How many items are finished one way or the other, which is what "3 of 7" counts. */
export function settledCount(items: AgentTodoItem[]): number {
  return items.filter(isSettled).length;
}

/** How many items are still to do, which is what the list is allowed fifty of. */
export function openCount(items: AgentTodoItem[]): number {
  return items.length - settledCount(items);
}

/**
 * The id the next item added should carry.
 *
 * Just the count plus one, which works only because nothing is ever removed
 * from a list - an item that turned out not to be needed is `cancelled` and
 * stays where it is. That is a deliberate property rather than a happy
 * accident: it keeps ids short enough for the model to quote back reliably,
 * and it keeps the list an account of what was planned rather than of what
 * survived.
 */
export function nextTodoId(items: AgentTodoItem[]): string {
  return String(items.length + 1);
}

/**
 * Whether the list moved in a way that counts as progress.
 *
 * Deliberately not "did anything change". A model that is being asked to keep
 * its list current, and would rather not do the work, has one cheap way out:
 * change something. Flipping an item from `in_progress` back to `pending` and
 * forward again every round is a change every round, and a check that only
 * asked whether the list differed would never fire while the model went
 * nowhere - which is precisely the case the check exists for.
 *
 * So progress is counted, not diffed: either something finished, or something
 * new was taken on. Neither of those can be faked by moving an item back and
 * forth, because both are counts that only go up.
 *
 * The cost is that starting an item does not reset the clock, so an item that
 * genuinely takes many rounds will eventually be asked about. That is the
 * right trade - after this many rounds on one item, "finish it, split it, or
 * say what is blocking you" is good advice rather than a false alarm.
 */
export function progressed(before: AgentTodoItem[], after: AgentTodoItem[]): boolean {
  return settledCount(after) > settledCount(before) || after.length > before.length;
}

/**
 * The streak after a round, given what it was before and what the list did.
 *
 * A finished list has no streak: there is nothing left to be stale about, and
 * counting rounds against a list whose work is done would eventually nag the
 * model about a plan it completed.
 */
export function nextStreak(
  streak: number,
  before: AgentTodoItem[],
  after: AgentTodoItem[]
): number {
  if (!hasOpenWork(after)) return 0;
  return progressed(before, after) ? 0 : streak + 1;
}

const MARK: Record<AgentTodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]'
};

function renderTodoItem(item: AgentTodoItem): string {
  return `${item.id}. ${MARK[item.status]} ${item.content}`;
}

/** The list in full, one item per line. What the pane has room to show. */
export function renderTodoList(items: AgentTodoItem[]): string {
  return items.map(renderTodoItem).join('\n');
}

/**
 * The list as the model reads it back: every open item in full, and a long run
 * of finished ones as a single line naming how many and which.
 *
 * Written for where this text ends up rather than for how it reads. The block
 * that carries it is spliced onto a copy of the conversation and thrown away
 * each round, so its cost is a rounding error - but the same render is the
 * result of every `todo_add` and `todo_update`, and a tool result is transcript:
 * it is stored, replayed on every later turn, and dragged through compaction. A
 * fifty-item plan takes at least a hundred todo calls, so printing all fifty
 * lines in each of them leaves tens of thousands of tokens of near-identical
 * snapshots sitting in the conversation for good.
 *
 * Open items are never summarized. They are the ones the model is about to act
 * on and the ids it has to quote back, and getting those wrong to save a line
 * would be trading the thing this feature is for against the thing it costs.
 * The elided line still names its id range, so a finished item can be reopened
 * or cancelled without having to ask what it was called.
 */
export function renderTodoBrief(items: AgentTodoItem[]): string {
  if (items.length <= TODO_BRIEF_AT) return renderTodoList(items);

  const lines: string[] = [];
  let run: AgentTodoItem[] = [];

  // A run of one is printed as itself: "3-3. 1 item finished" says less than
  // the item does and takes the same room.
  const flushRun = (): void => {
    if (run.length === 0) return;
    lines.push(
      run.length === 1
        ? renderTodoItem(run[0])
        : `${run[0].id}-${run[run.length - 1].id}. ${run.length} items finished or cancelled.`
    );
    run = [];
  };

  for (const item of items) {
    if (isSettled(item)) {
      run.push(item);
      continue;
    }
    flushRun();
    lines.push(renderTodoItem(item));
  }
  flushRun();

  return lines.join('\n');
}

/**
 * What the model is told when it has no list at all.
 *
 * The one place this feature can push on a model that has not opted in, and so
 * the only thing standing between "the agent keeps its list current" and "the
 * agent never makes one". Written to be easy to ignore, because most requests
 * genuinely do not want a list and being told to make one for a one-line
 * question would be noise the model learns to tune out - which would cost us
 * the times it matters.
 */
const NO_LIST_NUDGE = [
  'You have no task list for this conversation.',
  '',
  'If what you are doing has several steps worth tracking separately, start one with `todo_add` now - it is what keeps you working the whole job rather than the part of it in front of you, and the user can see it. If this is a single step or a question, there is nothing to track and you should ignore this.'
].join('\n');

function rung(streak: number, items: AgentTodoItem[]): string {
  const active = activeItem(items);

  // Past the top rung and not on one of its rounds: the demand has been made
  // recently and repeating it is what stopped the work last time. See
  // TODO_ESCALATE_EVERY.
  const escalated =
    streak >= TODO_ESCALATE_AT && (streak - TODO_ESCALATE_AT) % TODO_ESCALATE_EVERY === 0;

  if (streak < TODO_NUDGE_AT || (streak >= TODO_ESCALATE_AT && !escalated)) {
    // The cancel clause belongs here and not only further up the ladder. A user
    // who changes their mind does it in a fresh turn, where the streak has just
    // reset to zero - so the rung that talks about abandoning work is the one
    // rung a superseded plan will never reach, and the model is left reading a
    // list the user has already moved on from with nothing telling it it may
    // strike anything off.
    return 'Keep this current as you go: mark an item `in_progress` when you start it, and `completed` the moment it is actually done rather than saving them all up for the end. Add anything the work turns up that is not already here, and cancel anything the user has since moved on from.';
  }

  if (streak < TODO_ESCALATE_AT) {
    const on = active === null ? 'this list' : `\`${active.id}\``;
    return `Nothing on this list has finished in ${streak} rounds. If you are still genuinely working on ${on}, carry on - but if something above is already done, check it off now, and if the work has moved somewhere the list does not mention, add it. Do not call the todo tools just to have called them: re-saving an item as it already was is not progress.`;
  }

  return `This list has not moved in ${streak} rounds, which is long enough to be worth stopping over. Before anything else, make it true: check off what is genuinely finished, add what you are actually doing, and cancel what turned out not to be needed. If you are stuck, say so plainly in your reply and leave the item where it is - an honest blocked item is worth more than a list that has quietly stopped describing the work.`;
}

/**
 * The block that rides into the conversation on every round, or `null` when
 * there is nothing worth saying.
 *
 * Silent once every item is settled. A list that has been fully worked through
 * has made its point, and repeating it for the rest of the conversation would
 * be the model paying for the same reminder over and over.
 */
export function renderTodoBlock(items: AgentTodoItem[], streak: number): string | null {
  if (items.length === 0) return NO_LIST_NUDGE;
  if (!hasOpenWork(items)) return null;

  return [
    'Your task list for this conversation, as it stands right now:',
    '',
    renderTodoBrief(items),
    '',
    rung(streak, items)
  ].join('\n');
}

/**
 * What the agent is told about the task list, appended to the system prompt.
 *
 * Separate from the per-round block because the two say different things. This
 * says what the tools are and when to reach for them, once; the block says what
 * the list currently is, every round. Putting the instructions in the block too
 * would mean paying for them on every round-trip of a long turn.
 */
export const AGENT_TODO_INSTRUCTIONS = [
  '`todo_add` and `todo_update` keep a short list of what you are trying to get done, which the user can see while you work. Start one whenever a request breaks into steps you could get through in the wrong order or forget - and skip it entirely for a question, or for something that is one edit and done.',
  '',
  'Write each item as the outcome rather than the action, so the finished list reads as an account of what happened rather than of what was attempted. Mark an item `in_progress` before you start it and `completed` the moment it is genuinely done - not when you are nearly sure, and never in a batch at the end, which turns the list into a summary written after the fact. Only one item is `in_progress` at a time: it answers what you are doing right now, and two answers to that is not an answer.',
  '',
  'Keep it honest when things go wrong. An item you could not finish stays `in_progress` and you say why in your reply; work that turned out to be unnecessary is `cancelled` rather than quietly marked done. Nothing is ever deleted, so the list still accounts for the whole of what you planned.',
  '',
  'The user is shown the list, so do not read it back to them. Say what you did and what you found.'
].join('\n');
