import { useEffect, useState } from 'react';
import { SquareTerminal, X } from 'lucide-react';
import type { BackgroundRow } from './background-view';
import { formatElapsed } from './activity';
import { SideColumnCard } from './SideColumnCard';

/**
 * The commands the agent left running, beside the conversation.
 *
 * A background command answers on the turn that starts it with an id and
 * nothing else, so its row in the transcript reads "done" while the server it
 * started goes on running. Here is where it is still running - what it is, how
 * long it has been going, the last thing it said - and the one button that
 * matters, which is stopping it.
 *
 * Only the running ones, and they leave the moment they end, for the reason the
 * subagent card gives: what a finished command printed is the model's to read,
 * and this is a list of what is still out there.
 */
export function AgentBackgroundPanel({
  rows,
  onStop
}: {
  rows: BackgroundRow[];
  onStop: (id: string) => void;
}): React.JSX.Element | null {
  const now = useNow(rows.length > 0);
  if (rows.length === 0) return null;

  return (
    <SideColumnCard label="Background" name="Background commands" count={String(rows.length)}>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-2">
        {rows.map((row) => (
          <Row key={row.id} row={row} now={now} onStop={onStop} />
        ))}
      </ul>
    </SideColumnCard>
  );
}

/**
 * One command: what it is and for how long on the first line, what it last
 * printed on the second.
 */
function Row({
  row,
  now,
  onStop
}: {
  row: BackgroundRow;
  now: number;
  onStop: (id: string) => void;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-0.5 rounded px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <SquareTerminal size={12} className="shrink-0 text-fleet-text-subtle" />
        <span className="min-w-0 truncate font-mono text-xs" title={row.command}>
          {row.command}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-fleet-text-subtle tabular-nums">
          {formatElapsed(now - row.startedAt)}
        </span>
        <button
          type="button"
          onClick={() => onStop(row.id)}
          aria-label={`Stop ${row.command}`}
          title="Stop this command"
          className="shrink-0 text-fleet-text-subtle transition-colors hover:text-fleet-text focus-ring"
        >
          <X size={12} />
        </button>
      </div>
      <span
        className="truncate pl-[18px] font-mono text-[11px] text-fleet-text-muted"
        title={row.lastLine ?? undefined}
      >
        {row.lastLine ?? 'no output yet'}
      </span>
    </li>
  );
}

/**
 * The time, once a second while there is a clock on screen. Stopped when there
 * is not, so an idle pane is not re-rendering for a card it is not showing.
 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}
