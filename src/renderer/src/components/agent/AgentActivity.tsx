import { useEffect, useState } from 'react';
import type { AgentMessage } from '../../../../shared/agent-types';
import { agentPhase, formatElapsed, phaseShimmers, PHASE_LABEL } from './activity';

/**
 * What the agent is doing, while it is doing it.
 *
 * A waiting model gives no output at all, sometimes for a minute - the gap the
 * indicator exists to fill. It says which of the two silences this is (no
 * tokens yet, or reasoning the answer isn't in), and how long it has lasted,
 * because "is it stuck?" is the actual question and only the clock answers it.
 *
 * The shimmer sweeps across the word rather than spinning next to it: a
 * spinner is a second thing on the row, and this one has to share it with the
 * context meter.
 */
export function AgentActivity({
  last,
  compacting,
  startedAt
}: {
  /** The message being streamed into, which is what says how far the turn got. */
  last: AgentMessage | undefined;
  compacting: boolean;
  startedAt: number | null;
}): React.JSX.Element {
  const phase = agentPhase(last, compacting);
  const elapsed = useElapsed(startedAt);

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* Only the label is announced. The clock ticks every second and would
          otherwise be read out every second with it. */}
      <span
        aria-live="polite"
        className={`truncate ${
          phaseShimmers(phase) ? 'fleet-shimmer-text' : 'text-fleet-text-muted'
        }`}
      >
        {PHASE_LABEL[phase]}…
      </span>
      {elapsed !== null && (
        <span aria-hidden="true" className="shrink-0 tabular-nums text-fleet-text-subtle">
          {formatElapsed(elapsed)}
        </span>
      )}
    </span>
  );
}

/**
 * Milliseconds since the turn began, refreshed once a second.
 *
 * The start time comes from the store rather than a mount effect, so leaving
 * the pane for the Settings tab and coming back shows how long the turn has
 * really been running instead of restarting the clock.
 */
function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return startedAt === null ? null : Math.max(0, now - startedAt);
}
