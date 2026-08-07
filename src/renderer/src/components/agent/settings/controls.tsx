import { useState } from 'react';
import { RotateCcw } from 'lucide-react';

/**
 * Shared class strings for the native inputs and selects in these panes, so
 * every field looks the same. Compose with width utilities at the call site
 * (e.g. `${inputCls} w-24`).
 */
export const inputCls =
  'rounded-md border border-fleet-border-strong bg-fleet-surface-2 px-2.5 py-1.5 text-sm text-fleet-text outline-none transition-colors focus:border-fleet-text-subtle placeholder:text-fleet-text-subtle';

export const selectCls = `${inputCls} cursor-pointer`;

/**
 * A numeric inference parameter. Unset is a distinct state - the parameter is
 * left out of the request - but the readout still shows the number that will
 * actually be used rather than a vague "default", so the setting is never a
 * mystery. The reset arrow returns to that default.
 */
export function ParamSlider({
  label,
  hint,
  value,
  defaultValue,
  defaultNote = 'default',
  onChange,
  min,
  max,
  step,
  format = String
}: {
  label: string;
  hint?: string;
  value: number | null;
  /** What the model does when the parameter is omitted. Shown as the readout. */
  defaultValue: number;
  /** Where that default comes from, e.g. "model default", "provider default". */
  defaultNote?: string;
  onChange: (next: number | null) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}): React.JSX.Element {
  // Dragging emits a change per pixel, so the slider tracks locally and only
  // persists when the user lets go.
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value ?? defaultValue;
  const isDefault = dragging === null && value === null;

  const commit = (): void => {
    if (dragging === null) return;
    onChange(dragging);
    setDragging(null);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm text-fleet-text-secondary">{label}</span>
          {hint && <p className="mt-0.5 text-xs text-fleet-text-muted">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-sm tabular-nums text-fleet-text">{format(shown)}</span>
          {isDefault ? (
            <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle">
              {defaultNote}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDragging(null);
                onChange(null);
              }}
              title={`Reset to ${format(defaultValue)}`}
              aria-label={`Reset ${label}`}
              className="rounded p-0.5 text-fleet-text-subtle transition-colors hover:text-fleet-text-secondary focus-ring"
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={label}
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        // color-scheme keeps Chromium from painting the unfilled track in its
        // light-theme grey, which reads as a bright bar at full width.
        className="w-full fleet-accent-input [color-scheme:dark]"
      />
    </div>
  );
}

/**
 * Small pill group for a fixed set of values, e.g. reasoning effort levels.
 *
 * Generic in the value so a caller with a narrower union than `string` - the
 * image resolutions, the quality levels - gets that union back out of
 * `onChange` rather than having to assert its way to it.
 */
export function OptionPills<T extends string>({
  label,
  hint,
  options,
  value,
  onChange
}: {
  label: string;
  hint?: string;
  options: readonly T[];
  value: T | null;
  onChange: (next: T | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="text-sm text-fleet-text-secondary">{label}</span>
        {hint && <p className="mt-0.5 text-xs text-fleet-text-muted">{hint}</p>}
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex shrink-0 items-center gap-0.5 rounded-lg border border-fleet-border bg-fleet-surface p-0.5"
      >
        {[null, ...options].map((option) => {
          const selected = value === option;
          return (
            <button
              key={option ?? 'default'}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors focus-ring ${
                selected
                  ? 'bg-fleet-surface-3 text-fleet-text'
                  : 'text-fleet-text-muted hover:text-fleet-text-secondary'
              }`}
            >
              {option ?? 'default'}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Card wrapper for one agent role. The role's job is spelled out under the
 * title, since "coding" vs "image" is the only thing distinguishing two
 * otherwise identical blocks of controls.
 */
export function RoleCard({
  title,
  description,
  icon,
  children
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-fleet-border bg-fleet-surface p-4">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fleet-text">{title}</h3>
          <p className="mt-0.5 text-xs text-fleet-text-muted">{description}</p>
        </div>
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
