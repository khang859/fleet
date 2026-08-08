import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import { AgentToolRow } from './AgentToolRow';
import { runLabel, runPreview, runRunning } from './tool-group';

/**
 * A run of the same lookup, on one line, with the rows behind a disclosure.
 *
 * The same row as the one it folds - verb, then the thing it acted on - so the
 * transcript does not change shape where a sweep happens. What is different is
 * that the thing it acted on is a count, and the individual targets have become
 * a preview of themselves.
 *
 * Opening it gives back exactly the rows that would have been there, each still
 * its own disclosure over its own output. Nothing is summarised away: the fold
 * is about height, and everything it costs is one click from where it was.
 */
export function AgentToolGroup({
  name,
  calls,
  cleared
}: {
  name: string;
  calls: AgentToolCall[];
  /** Calls whose result is no longer being sent to the model, by call id. */
  cleared: Set<string>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const running = runRunning(calls);

  // A running group opens like any other, which is where it parts company with a
  // running row. A row that has not come back has nothing underneath it to show;
  // a sweep that is on its sixth file has five files' worth, and a reader who
  // opened them should not have them taken away again because the agent went and
  // read one more. Only the label shimmers, because the label is the only part of
  // this row that is still changing.
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span
          className={`flex min-w-0 items-center gap-1.5 ${running ? 'fleet-shimmer-text' : ''}`}
        >
          <span className="shrink-0">{runLabel(name, calls.length, running)}</span>
          <span className="truncate font-mono text-[11px]">{runPreview(name, calls)}</span>
        </span>
      </button>
      {open && (
        // Set in from the rows around it, so an open group reads as a list
        // belonging to the line above rather than as the transcript resuming.
        <div className="flex flex-col gap-1.5 border-l-2 border-fleet-border pl-3">
          {calls.map((call) => (
            <AgentToolRow key={call.id} call={call} cleared={cleared.has(call.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
