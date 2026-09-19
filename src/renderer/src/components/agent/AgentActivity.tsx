import { useEffect, useState } from 'react';
import { agentPhase, formatElapsed, phaseShimmers, PHASE_LABEL, type AgentStep } from './activity';

/**
 * What the agent is doing, while it is doing it.
 *
 * A waiting model gives no output at all, sometimes for a minute - the gap the
 * indicator exists to fill. It says which silence this is (no tokens yet,
 * reasoning, a tool call being written, a command being checked), and how long
 * this step has lasted, because "is it stuck?" is the actual question and only
 * the clock answers it.
 *
 * The shimmer sweeps across the word rather than spinning next to it: a
 * spinner is a second thing on the row, and this one has to share it with the
 * context meter.
 */
export function AgentActivity({
  step,
  compacting,
  asking,
  reasoningShown
}: {
  /** The step the turn is on, and since when. */
  step: AgentStep | null;
  compacting: boolean;
  /** Stopped on a command the user has to decide about. */
  asking: boolean;
  /** Whether the reasoning block is open and streaming, so already moving. */
  reasoningShown: boolean;
}): React.JSX.Element {
  const phase = agentPhase(step, compacting, asking);
  const elapsed = useElapsed(step?.since ?? null);

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* Only the label is announced. The clock ticks every second and would
          otherwise be read out every second with it. */}
      {/* Nothing shimmers while it is the user who is being waited on: a
          sweeping word would say work is happening when none is. */}
      <span
        aria-live="polite"
        className={`truncate ${
          phase === 'asking'
            ? // Amber carries the meaning here, so it has to survive the light
              // themes too - amber-400 on a near-white pane is about 1.6:1.
              'text-amber-700 dark:text-amber-400/90'
            : phaseShimmers(phase, reasoningShown)
              ? 'fleet-shimmer-text'
              : 'text-fleet-text-muted'
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
 * Milliseconds since the step began, refreshed once a second.
 *
 * The start time comes from the store rather than a mount effect, so leaving
 * the pane for the Settings tab and coming back shows how long the step has
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
