import { Bot, X } from 'lucide-react';
import type { RunningSubagent } from './subagent-view';
import { SideColumnCard } from './SideColumnCard';

/**
 * The subagents still out there, beside the conversation.
 *
 * A dispatched subagent is the one thing in the pane with no home on screen
 * while it works. Its card is pinned to the row that started it, and the parent
 * goes on writing above that row until it has scrolled out of the pane - so with
 * three of them running for four minutes each, the honest answer to "what is
 * happening" is somewhere up the scroll, in three places, none of them on
 * screen. Here they are all in one place, and it is the same place the task list
 * is: what the column is for is the work in flight, which is exactly what the
 * transcript is the wrong shape for.
 *
 * Only the running ones, and they leave the moment they report. What a finished
 * subagent did is on its card in the transcript and in its own log, both of
 * which survive a restart - keeping it here as well would turn a list of what is
 * still out there into a second, worse transcript.
 *
 * Read-only apart from stopping one, in the same spirit as the task list. The
 * card is a glance, not a place to work: opening a child's transcript, its
 * prompt in full, and its report all stay on the card in the conversation, which
 * is where they are written down.
 */
export function AgentSubagentPanel({
  running,
  onStop
}: {
  running: RunningSubagent[];
  onStop: (taskId: string) => void;
}): React.JSX.Element | null {
  if (running.length === 0) return null;

  return (
    <SideColumnCard label="Subagents" name="Running subagents" count={String(running.length)}>
      {/* A wider gap than the task list's, because a row here is three lines
          rather than one: at the list's spacing the last line of one subagent
          and the name of the next are closer together than the lines within
          either, and the block stops reading as a block. */}
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-2">
        {running.map((subagent) => (
          <Row key={subagent.taskId} subagent={subagent} onStop={onStop} />
        ))}
      </ul>
    </SideColumnCard>
  );
}

/**
 * One subagent: which one, on what, and what it is doing about it.
 *
 * Three lines rather than one, unlike a task. A task is a line the model wrote
 * to be read as a line; a subagent is a name the user has to tell apart from
 * four others, a prompt that is the only thing telling them apart, and a status
 * that changes every few seconds. At this width those are three different
 * questions and stacking them is the only way all three stay legible.
 */
function Row({
  subagent,
  onStop
}: {
  subagent: RunningSubagent;
  onStop: (taskId: string) => void;
}): React.JSX.Element {
  const { agent, prompt, activity, asking } = subagent;

  return (
    <li className="flex flex-col gap-0.5 rounded px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <Bot size={12} className="shrink-0 text-fleet-text-subtle" />
        {/* Not shimmering while it is stopped on a question: nothing is moving,
            and the line below says so in words. */}
        <span className={`min-w-0 truncate text-xs ${asking ? '' : 'fleet-shimmer-text'}`}>
          {agent}
        </span>
        <button
          type="button"
          onClick={() => onStop(subagent.taskId)}
          aria-label={`Stop the ${agent} subagent`}
          title="Stop this subagent"
          className="ml-auto shrink-0 text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
        >
          <X size={12} />
        </button>
      </div>
      {/* Two lines of it rather than one: the prompt is the whole of what tells
          five children apart, and a single line of a 272px column is about six
          words - which for two subagents sent into the same folder is often the
          same six. Capped there, because a card that grows with what was asked
          would leave the fifth subagent off the bottom. */}
      {prompt !== '' && (
        <p className="line-clamp-2 pl-[18px] text-[11px] leading-[1.45] text-fleet-text-subtle">
          {prompt}
        </p>
      )}
      <span className="truncate pl-[18px] font-mono text-[11px] text-fleet-text-muted">
        {asking ? (
          <span className="font-sans text-amber-700 dark:text-amber-400/90">waiting on you</span>
        ) : (
          <span className="fleet-shimmer-text">{activity ?? 'starting'}</span>
        )}
      </span>
    </li>
  );
}
