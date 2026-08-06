import { useState } from 'react';
import { Check, ChevronRight, Circle, CircleDot, LoaderCircle, Minus } from 'lucide-react';
import type { AgentTodoItem, AgentTodoStatus } from '../../../../shared/agent-todos';
import { splitTodos, todoProgress, TODO_DONE_COLLAPSE_AT, TODO_PANEL_WIDTH_PX } from './todo-view';

/**
 * The agent's task list, beside the conversation.
 *
 * A column rather than a card in the transcript, because the two things are
 * read at different moments. The transcript is what happened, scrolled through
 * afterwards; the list is where the work has got to, glanced at while it is
 * still running - and a card that scrolls away with the message that wrote it
 * is exactly the wrong shape for that. Here it stays where it was put, and
 * checking it costs a look rather than a scroll.
 *
 * Read-only, deliberately. Every item on it is something the agent said it
 * would do, and a user tick would make the list a place where two authors
 * disagree - the model would then be handed a list saying an item is done that
 * it has no memory of doing.
 */
export function AgentTodoPanel({
  items,
  streaming
}: {
  items: AgentTodoItem[];
  /** Whether a turn is running, which decides whether a started item is live or stalled. */
  streaming: boolean;
}): React.JSX.Element | null {
  const progress = todoProgress(items);
  const { open, done } = splitTodos(items);
  // Per pane and per session, and it only ever opens: someone who asked to see
  // the finished work is not asking to be shown it once.
  const [showDone, setShowDone] = useState(false);
  if (progress === null) return null;

  const collapsed = done.length > TODO_DONE_COLLAPSE_AT && !showDone;

  return (
    <aside
      aria-label="Agent tasks"
      style={{ width: TODO_PANEL_WIDTH_PX }}
      // Glass rather than nothing: the pane may have a picture behind it, and a
      // list of short lines read straight off a photograph is the one thing
      // here small enough to disappear into one.
      className="flex min-h-0 shrink-0 flex-col border-l border-fleet-border bg-fleet-glass-bg backdrop-blur-md"
    >
      <div className="flex shrink-0 items-baseline gap-2 px-3.5 pt-5 pb-2">
        <h2 className="text-[11px] font-medium tracking-wide text-fleet-text-secondary uppercase">
          Tasks
        </h2>
        <span className="ml-auto font-mono text-[11px] text-fleet-text-subtle tabular-nums">
          {progress.count}
        </span>
      </div>
      {/* Work still to do first, so the top of the column is the answer to
          "what now" and the scroll position it starts at is the right one. The
          finished pile grows downwards, which is the direction it should push. */}
      <ol className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4">
        {open.map((item) => (
          <Row key={item.id} item={item} streaming={streaming} />
        ))}
        {collapsed ? (
          <li>
            <button
              type="button"
              onClick={() => setShowDone(true)}
              aria-expanded={false}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs text-fleet-text-subtle transition-colors hover:text-fleet-text-secondary focus-ring"
            >
              <Check size={12} className="shrink-0 text-emerald-400/90" />
              <span>{done.length} finished</span>
              <ChevronRight size={12} className="ml-auto shrink-0" />
            </button>
          </li>
        ) : (
          done.map((item) => <Row key={item.id} item={item} streaming={streaming} />)
        )}
      </ol>
    </aside>
  );
}

/**
 * One task.
 *
 * The mark carries the state and the text carries the task, so the two are not
 * saying the same thing twice. Only two of the four states change the words
 * themselves: done is struck through, and so is dropped - both are lines the
 * reader is finished with, and the difference between them is in the mark.
 */
function Row({ item, streaming }: { item: AgentTodoItem; streaming: boolean }): React.JSX.Element {
  const settled = item.status === 'completed' || item.status === 'cancelled';

  return (
    <li className="flex items-start gap-2 rounded px-1.5 py-1">
      <span className="mt-[3px] shrink-0">
        <Mark status={item.status} streaming={streaming} />
      </span>
      <span
        className={`text-xs leading-[1.45] ${
          settled
            ? 'text-fleet-text-subtle line-through'
            : item.status === 'in_progress'
              ? 'text-fleet-text'
              : 'text-fleet-text-muted'
        }`}
      >
        {item.content}
      </span>
    </li>
  );
}

/**
 * Four states, four marks. The running one spins, which is the only thing on
 * the list that is happening rather than settled - and is what makes the panel
 * worth glancing at rather than reading.
 *
 * It only spins while a turn is actually running. An item left `in_progress` is
 * the honest end of a blocked turn - the agent is told to leave it there and
 * explain in its reply - and a spinner next to an idle composer would claim
 * work is going on for as long as the conversation stays open. Stopped, it
 * reads as what it is: started, not finished.
 */
function Mark({
  status,
  streaming
}: {
  status: AgentTodoStatus;
  streaming: boolean;
}): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <Check size={12} className="text-emerald-400/90" />;
    case 'in_progress':
      return streaming ? (
        <LoaderCircle size={12} className="fleet-accent-text animate-spin" />
      ) : (
        <CircleDot size={12} className="fleet-accent-text" />
      );
    case 'cancelled':
      return <Minus size={12} className="text-fleet-text-subtle" />;
    case 'pending':
      return <Circle size={12} className="text-fleet-text-subtle" />;
  }
}
