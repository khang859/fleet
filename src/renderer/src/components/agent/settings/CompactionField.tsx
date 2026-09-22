import { useState } from 'react';
import type { CompactThreshold } from '../../../../../shared/agent-types';
import { DEFAULT_COMPACT_THRESHOLD } from '../../../../../shared/agent-types';
import {
  COMPACT_THRESHOLD_MAX,
  COMPACT_THRESHOLD_MIN,
  COMPACT_TOKENS_FALLBACK,
  COMPACT_TOKENS_MAX,
  COMPACT_TOKENS_MIN,
  convertThreshold
} from '../../../../../shared/agent-context';
import { commitNumber, shownNumber } from './bounded-number';
import { formatTokens } from './format';
import { Toggle } from './Toggle';

const percent = (fraction: number): number => Math.round(fraction * 100);

/**
 * When a transcript gets folded into a summary. Off means the agent never does
 * it unprompted, which is a real choice: compaction is lossy, and some work is
 * better served by starting a new pane than by an approximation of the old one.
 *
 * The threshold is said either as a share of the window or as a flat number of
 * tokens. The unit is not cosmetic: a fraction needs a context window to be a
 * fraction of, so on a model the catalog does not list - a local endpoint, most
 * often - it is the token count or nothing.
 */
export function CompactionField({
  value,
  contextLimit,
  onChange
}: {
  /** The threshold, or `null` for manual compaction only. */
  value: CompactThreshold | null;
  /** The coding model's window, used to say the same threshold the other way. */
  contextLimit: number | null;
  onChange: (value: CompactThreshold | null) => void;
}): React.JSX.Element {
  // The slider emits a change per pixel, so it tracks locally and persists on
  // release; the number field holds a draft so a half-typed number is not
  // clamped a digit at a time. Same problem, two shapes - see `bounded-number`.
  const [dragging, setDragging] = useState<number | null>(null);
  const [typing, setTyping] = useState<string | null>(null);

  const commitSlider = (): void => {
    if (dragging === null) return;
    setDragging(null);
    onChange({ unit: 'fraction', value: dragging / 100 });
  };

  const commitTokens = (): void => {
    if (typing === null) return;
    setTyping(null);
    onChange({
      unit: 'tokens',
      value: commitNumber(typing, {
        min: COMPACT_TOKENS_MIN,
        max: COMPACT_TOKENS_MAX,
        fallback: COMPACT_TOKENS_FALLBACK
      })
    });
  };

  // Whatever is half-edited is abandoned by a unit switch rather than carried
  // into the other unit: a percentage mid-drag is not a token count.
  const switchUnit = (unit: CompactThreshold['unit']): void => {
    if (value === null || value.unit === unit) return;
    setDragging(null);
    setTyping(null);
    onChange(convertThreshold(value, unit, contextLimit));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <span className="text-sm text-fleet-text-secondary">Compact automatically</span>
          <p className="mt-0.5 text-xs text-fleet-text-muted">
            Summarize the earlier messages once the conversation reaches this size. The last few
            exchanges are always kept word for word.
          </p>
        </div>
        <Toggle
          checked={value !== null}
          onChange={(next) => onChange(next ? DEFAULT_COMPACT_THRESHOLD : null)}
          ariaLabel="Compact automatically"
        />
      </div>

      {value !== null && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-fleet-text-muted">Compact at</span>
            <div className="flex items-center gap-2">
              {value.unit === 'fraction' ? (
                <span className="text-sm tabular-nums text-fleet-text">
                  {dragging ?? percent(value.value)}% full
                </span>
              ) : (
                <input
                  type="number"
                  min={COMPACT_TOKENS_MIN}
                  max={COMPACT_TOKENS_MAX}
                  step={1000}
                  value={shownNumber(typing, value.value)}
                  aria-label="Compact at"
                  onChange={(e) => setTyping(e.target.value)}
                  onBlur={commitTokens}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="w-24 rounded-md border border-fleet-border bg-fleet-glass-surface px-2 py-1 text-right text-sm tabular-nums text-fleet-text focus-ring"
                />
              )}
              <UnitPills unit={value.unit} onChange={switchUnit} />
            </div>
          </div>

          {value.unit === 'fraction' ? (
            <input
              type="range"
              min={percent(COMPACT_THRESHOLD_MIN)}
              max={percent(COMPACT_THRESHOLD_MAX)}
              step={5}
              value={dragging ?? percent(value.value)}
              aria-label="Compact at"
              onChange={(e) => setDragging(Number(e.target.value))}
              onPointerUp={commitSlider}
              onKeyUp={commitSlider}
              onBlur={commitSlider}
              className="w-full fleet-accent-input"
            />
          ) : (
            <p className="text-xs text-fleet-text-muted">
              {contextLimit === null
                ? 'A flat count needs no context window, so it is the one setting that works on a model the catalog does not list.'
                : `About ${percent(Math.min(1, value.value / contextLimit))}% of the coding model’s ${formatTokens(contextLimit)} window.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const UNITS: Array<{ unit: CompactThreshold['unit']; label: string }> = [
  { unit: 'fraction', label: '%' },
  { unit: 'tokens', label: 'tokens' }
];

/** Two ways of saying one threshold. Not `OptionPills`, which carries a third, null option. */
function UnitPills({
  unit,
  onChange
}: {
  unit: CompactThreshold['unit'];
  onChange: (unit: CompactThreshold['unit']) => void;
}): React.JSX.Element {
  return (
    <span
      role="radiogroup"
      aria-label="Threshold unit"
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-fleet-border bg-fleet-surface p-0.5"
    >
      {UNITS.map((option) => {
        const selected = option.unit === unit;
        return (
          <button
            key={option.unit}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.unit)}
            className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors focus-ring ${
              selected
                ? 'bg-fleet-surface-3 text-fleet-text'
                : 'text-fleet-text-muted hover:text-fleet-text-secondary'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </span>
  );
}
