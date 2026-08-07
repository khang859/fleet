import { useState } from 'react';
import { DEFAULT_AGENT_SETTINGS } from '../../../../../shared/agent-types';
import { COMPACT_THRESHOLD_MAX, COMPACT_THRESHOLD_MIN } from '../../../../../shared/agent-context';
import { Toggle } from './Toggle';

const DEFAULT_THRESHOLD = DEFAULT_AGENT_SETTINGS.compactThreshold ?? 0.8;
const percent = (fraction: number): number => Math.round(fraction * 100);

/**
 * When a transcript gets folded into a summary. Off means the agent never does
 * it unprompted, which is a real choice: compaction is lossy, and some work is
 * better served by starting a new pane than by an approximation of the old one.
 */
export function CompactionField({
  value,
  onChange
}: {
  /** Fraction of the context window, or `null` for manual compaction only. */
  value: number | null;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  // The slider emits a change per pixel, so it tracks locally and persists on release.
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? percent(value ?? DEFAULT_THRESHOLD);

  const commit = (): void => {
    if (dragging === null) return;
    onChange(dragging / 100);
    setDragging(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span className="text-sm text-fleet-text-secondary">Compact automatically</span>
          <p className="mt-0.5 text-xs text-fleet-text-muted">
            Summarize the earlier messages once the conversation fills this much of the model&apos;s
            context window. The last few exchanges are always kept word for word.
          </p>
        </div>
        <Toggle
          checked={value !== null}
          onChange={(next) => onChange(next ? DEFAULT_THRESHOLD : null)}
          ariaLabel="Compact automatically"
        />
      </div>

      {value !== null && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-fleet-text-muted">Compact at</span>
            <span className="text-sm tabular-nums text-fleet-text">{shown}% full</span>
          </div>
          <input
            type="range"
            min={percent(COMPACT_THRESHOLD_MIN)}
            max={percent(COMPACT_THRESHOLD_MAX)}
            step={5}
            value={shown}
            aria-label="Compact at"
            onChange={(e) => setDragging(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-full fleet-accent-input [color-scheme:dark]"
          />
        </div>
      )}
    </div>
  );
}
