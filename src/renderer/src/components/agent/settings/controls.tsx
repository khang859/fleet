import { useState } from 'react';
import { RotateCcw } from 'lucide-react';

/**
 * A numeric inference parameter. Unset means "let the provider decide", which
 * is a real state and not the same as any particular number - so the readout
 * says so, and a reset arrow puts it back once the user has picked a value.
 */
export function ParamSlider({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  format = String
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (next: number | null) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}): React.JSX.Element {
  // Dragging emits a change per pixel, so the slider tracks locally and only
  // persists when the user lets go.
  const [dragging, setDragging] = useState<number | null>(null);
  // The thumb needs a position even when nothing is set; park it at the low end
  // rather than inventing a value the agent would not actually send.
  const sliderValue = dragging ?? value ?? min;
  const shown = dragging ?? value;

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
          <span
            className={`text-sm tabular-nums ${shown === null ? 'text-fleet-text-subtle' : 'text-fleet-text'}`}
          >
            {shown === null ? 'Provider default' : format(shown)}
          </span>
          {shown !== null && (
            <button
              type="button"
              onClick={() => {
                setDragging(null);
                onChange(null);
              }}
              title="Reset to provider default"
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
        value={sliderValue}
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

/** Small pill group for a fixed set of values, e.g. reasoning effort levels. */
export function OptionPills({
  label,
  hint,
  options,
  value,
  onChange
}: {
  label: string;
  hint?: string;
  options: readonly string[];
  value: string | null;
  onChange: (next: string | null) => void;
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
        {['default', ...options].map((option) => {
          const isDefault = option === 'default';
          const selected = isDefault ? value === null : value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(isDefault ? null : option)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors focus-ring ${
                selected
                  ? 'bg-fleet-surface-3 text-fleet-text'
                  : 'text-fleet-text-muted hover:text-fleet-text-secondary'
              }`}
            >
              {option}
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
