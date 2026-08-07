import { useState } from 'react';
import { MAX_TOOL_ROUNDS_CEILING, MAX_TOOL_ROUNDS_MIN } from '../../../../../shared/agent-types';
import { Toggle } from '../../chat/settings/Toggle';

/**
 * What a cap is set to when it is first switched on. Well past what a real
 * request takes, so turning the setting on does not by itself change how any
 * ordinary turn behaves - it puts a floor under the worst case.
 */
const DEFAULT_ROUNDS = 50;

/**
 * How long one turn may go on.
 *
 * Off by default, which is the unusual choice and the deliberate one: a cap is
 * a guess at how long a job takes made by someone who has not seen the job, and
 * a turn stopped at its limit has spent everything it cost to get there and
 * left the folder halfway through. Keeping the agent on the plan is the task
 * list's job. This is here for someone who would rather be stopped early than
 * find out afterwards what it ran up.
 */
export function MaxToolRoundsField({
  value,
  onChange
}: {
  /** Rounds of tool calls, or `null` for as many as the turn needs. */
  value: number | null;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  // Typed locally so a half-written number is not committed a digit at a time -
  // "10" on the way to "100" is a real setting, and saving it would clamp the
  // field out from under the cursor.
  const [typing, setTyping] = useState<string | null>(null);

  const commit = (): void => {
    if (typing === null) return;
    const parsed = Number(typing);
    setTyping(null);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(MAX_TOOL_ROUNDS_CEILING, Math.max(MAX_TOOL_ROUNDS_MIN, Math.round(parsed))));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span className="text-sm text-fleet-text-secondary">Limit tool rounds</span>
          <p className="mt-0.5 text-xs text-fleet-text-muted">
            Stop a turn after this many rounds of tool calls. Off means it runs until it has an
            answer, which is what long work needs - a turn that hits a limit has already spent what
            it cost to get there.
          </p>
        </div>
        <Toggle
          checked={value !== null}
          onChange={(next) => onChange(next ? DEFAULT_ROUNDS : null)}
          ariaLabel="Limit tool rounds"
        />
      </div>

      {value !== null && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-fleet-text-muted">Stop after</span>
          <span className="flex items-baseline gap-1.5">
            <input
              type="number"
              min={MAX_TOOL_ROUNDS_MIN}
              max={MAX_TOOL_ROUNDS_CEILING}
              step={1}
              value={typing ?? String(value)}
              aria-label="Stop after"
              onChange={(e) => setTyping(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="w-20 rounded-md border border-fleet-border bg-fleet-glass-surface px-2 py-1 text-right text-sm tabular-nums text-fleet-text focus-ring"
            />
            <span className="text-xs text-fleet-text-muted">rounds</span>
          </span>
        </div>
      )}
    </div>
  );
}
