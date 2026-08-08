import { Clock, Repeat, X } from 'lucide-react';
import type { ScheduleRow } from './schedule-view';
import { SideColumnCard } from './SideColumnCard';

/**
 * What the conversation has set to wake itself up, beside the conversation.
 *
 * The one thing in the pane that can start a turn with nobody in the room, and
 * the reason this card is not optional: a reminder the user cannot see is a
 * reminder they cannot stop, and the bill for one that outlived its purpose
 * arrives whether or not they ever knew it was set. Everything set is here,
 * with the button that ends it, for as long as it is set.
 *
 * Sourced from what main pushes rather than reconstructed from the transcript,
 * for the same reason the subagent list is: a schedule is live state that
 * outlives the turn that created it, and the tool call that created it says only
 * what was asked for, not what is still standing.
 */
export function AgentSchedulePanel({
  rows,
  onCancel
}: {
  rows: ScheduleRow[];
  onCancel: (id: string) => void;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;

  return (
    <SideColumnCard label="Schedules" name="Scheduled check-ins" count={String(rows.length)}>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-2">
        {rows.map((row) => (
          <Row key={row.id} row={row} onCancel={onCancel} />
        ))}
      </ul>
    </SideColumnCard>
  );
}

/**
 * One schedule: when it fires, whether it keeps firing, and what it is about.
 *
 * When first, because that is the question a list of these is read to answer.
 * The expression sits under it in mono as the exact answer behind the friendly
 * one - and it is also what the user would have to read to understand why a
 * reminder they meant for Monday says Thursday.
 */
function Row({
  row,
  onCancel
}: {
  row: ScheduleRow;
  onCancel: (id: string) => void;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-0.5 rounded px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <Clock size={12} className="shrink-0 text-fleet-text-subtle" />
        {/* Shimmering only once its moment has been claimed, which is the one
            state where something is actually about to happen. */}
        <span className={`min-w-0 truncate text-xs ${row.due ? 'fleet-shimmer-text' : ''}`}>
          {row.when}
        </span>
        {row.recurring && (
          <Repeat size={11} className="shrink-0 text-fleet-text-subtle" aria-label="Repeats" />
        )}
        <button
          type="button"
          onClick={() => onCancel(row.id)}
          aria-label={`Cancel the check-in ${row.when}`}
          title="Cancel this check-in"
          className="ml-auto shrink-0 text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
        >
          <X size={12} />
        </button>
      </div>
      {/* Two lines of it, capped the way the subagent prompt is: the note is the
          whole of what tells two check-ins apart, and a card that grew with what
          the model wrote would leave the third one off the bottom. */}
      <p className="line-clamp-2 pl-[18px] text-[11px] leading-[1.45] text-fleet-text-subtle">
        {row.note}
      </p>
      <span className="truncate pl-[18px] font-mono text-[11px] text-fleet-text-muted">
        {row.cron}
      </span>
    </li>
  );
}
