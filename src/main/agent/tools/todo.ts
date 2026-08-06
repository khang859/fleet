import type {
  AgentToolContext,
  AgentToolResult,
  TodoAddArgs,
  TodoUpdateArgs
} from '../../../shared/agent-tools';
import {
  TODO_MAX_ITEMS,
  activeItem,
  nextTodoId,
  openCount,
  renderTodoBrief,
  settledCount,
  type AgentTodoItem
} from '../../../shared/agent-todos';

/**
 * The two tools that write the agent's task list.
 *
 * The only tools here that change nothing outside the conversation. What they
 * write is a promise about what is going to happen, which the user watches and
 * which is handed back to the model on every round - so the thing that can go
 * wrong is not damage, it is the list quietly ceasing to describe the work.
 *
 * Both answer with the list rather than with "ok". It costs a few lines and
 * buys the model an unambiguous account of what it just did, in the same place
 * it would look for one: two calls in the same round then cannot disagree about
 * what the list is, and a model that has misremembered an item's number finds
 * out here instead of two rounds later. `renderTodoBrief` rather than the whole
 * list because a tool result is transcript and is paid for on every later turn;
 * the parts two calls could disagree about are the open items, and those are
 * never the parts it leaves out.
 */

export function runTodoAdd(args: TodoAddArgs, ctx: AgentToolContext): AgentToolResult {
  const before = ctx.todos.list();
  // Against open work, so a session that has finished fifty things is not
  // refused a fifty-first. See TODO_MAX_ITEMS.
  const room = TODO_MAX_ITEMS - openCount(before);
  if (args.items.length > room) {
    throw new Error(
      room <= 0
        ? `You already have ${TODO_MAX_ITEMS} unfinished tasks, which is the limit, so nothing was added. Finish or cancel some of them before planning more.`
        : `That would take you past the limit of ${TODO_MAX_ITEMS} unfinished tasks, so nothing was added. There is room for ${room} more - add the next few steps rather than the whole plan.`
    );
  }

  // Ids are minted against the list as it grows rather than against the list as
  // it arrived, so several items in one call come out numbered in order.
  const items = args.items.reduce<AgentTodoItem[]>(
    (list, draft) => [
      ...list,
      {
        id: nextTodoId(list),
        content: draft.content,
        activeForm: draft.activeForm ?? null,
        status: 'pending'
      }
    ],
    before
  );

  ctx.todos.save(items);

  const added = items.length - before.length;
  return {
    text: [
      `Added ${added} ${added === 1 ? 'task' : 'tasks'}. Your list is now:`,
      '',
      renderTodoBrief(items)
    ].join('\n'),
    summary: `+${added}`,
    todos: items
  };
}

export function runTodoUpdate(args: TodoUpdateArgs, ctx: AgentToolContext): AgentToolResult {
  const before = ctx.todos.list();
  const target = before.find((item) => item.id === args.id);
  if (target === undefined) {
    throw new Error(
      before.length === 0
        ? `There is no task ${args.id} because you have no task list yet. Use todo_add to start one.`
        : `There is no task ${args.id}. Your list is:\n\n${renderTodoBrief(before)}`
    );
  }

  /*
   * The one rule worth refusing over. "What are you doing right now" has one
   * answer, and a list with two items running is a list that has stopped
   * answering it - which is exactly when it stops being worth showing. An
   * empty list is never refused for the mirror-image reason: between finishing
   * one item and starting the next there is genuinely nothing in progress.
   */
  const running = activeItem(before);
  if (args.status === 'in_progress' && running !== null && running.id !== args.id) {
    throw new Error(
      // Cancelling is offered first on purpose. This refusal is most often hit
      // across turns, against an item left running because it was blocked - and
      // of the ways out, marking that item `completed` is the shortest to type
      // and the only dishonest one. Naming the honest ones first is the whole
      // difference between a list that records a blockage and one that hides it.
      `Task ${running.id} (${running.content}) is already in progress, and only one task may be at a time. Cancel it if it turned out not to be needed, finish it if it is done, or say which of the two you are actually working on - and if it is blocked, leave it and say so in your reply rather than marking it done.`
    );
  }

  const items = before.map((item) =>
    item.id === args.id
      ? {
          ...item,
          content: args.content ?? item.content,
          activeForm: args.activeForm ?? item.activeForm,
          status: args.status
        }
      : item
  );

  ctx.todos.save(items);

  return {
    text: [`Task ${args.id} is now ${args.status}. Your list is:`, '', renderTodoBrief(items)].join(
      '\n'
    ),
    summary: `${settledCount(items)}/${items.length} done`,
    todos: items
  };
}
