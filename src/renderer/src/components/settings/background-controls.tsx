import { useState } from 'react';

// ── shared helpers ────────────────────────────────────────────────────────────

const FIELD_CLASS =
  'bg-fleet-surface-2 text-fleet-text text-xs rounded px-1 py-0.5 border border-fleet-border-strong text-right';

const BUTTON_CLASS =
  'bg-fleet-surface-2 text-fleet-text text-sm rounded px-1.5 py-1 border border-fleet-border-strong hover:border-fleet-text-subtle transition active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ── SliderInput ───────────────────────────────────────────────────────────────

export function SliderInput(props: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  parse?: (s: string) => number;
  unit?: string;
  ariaLabel: string;
}): React.JSX.Element {
  const {
    value,
    onChange,
    min,
    max,
    step,
    format = String,
    parse = Number,
    unit,
    ariaLabel
  } = props;

  const [fieldText, setFieldText] = useState<string | null>(null);
  const focused = fieldText !== null;

  function handleRangeChange(e: React.ChangeEvent<HTMLInputElement>): void {
    onChange(clamp(Number(e.target.value), min, max));
  }

  function handleFieldChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setFieldText(e.target.value);
  }

  function commit(): void {
    if (fieldText === null) return;
    const parsed = parse(fieldText);
    if (isNaN(parsed)) {
      setFieldText(null); // revert
    } else {
      const clamped = clamp(parsed, min, max);
      onChange(clamped);
      setFieldText(null);
    }
  }

  function handleFieldKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }

  return (
    <span className="flex items-center gap-2">
      <input
        type="range"
        className="w-40 fleet-accent-input"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleRangeChange}
        aria-label={ariaLabel}
      />
      <input
        type="text"
        inputMode="decimal"
        className={`w-12 ${FIELD_CLASS}`}
        value={focused ? fieldText : format(value)}
        onChange={handleFieldChange}
        onFocus={() => setFieldText(format(value))}
        onBlur={commit}
        onKeyDown={handleFieldKeyDown}
        aria-label={ariaLabel}
      />
      {unit && <span className="text-fleet-text-subtle text-xs">{unit}</span>}
    </span>
  );
}

// ── NumberStepper ─────────────────────────────────────────────────────────────

export function NumberStepper(props: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  parse?: (s: string) => number;
  unit?: string;
  ariaLabel: string;
}): React.JSX.Element {
  const {
    value,
    onChange,
    min,
    max,
    step,
    format = String,
    parse = Number,
    unit,
    ariaLabel
  } = props;

  const [fieldText, setFieldText] = useState<string | null>(null);
  const focused = fieldText !== null;

  function step_(delta: number): void {
    onChange(clamp(value + delta, min, max));
  }

  function handleFieldChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setFieldText(e.target.value);
  }

  function commit(): void {
    if (fieldText === null) return;
    const parsed = parse(fieldText);
    if (isNaN(parsed)) {
      setFieldText(null);
    } else {
      onChange(clamp(parsed, min, max));
      setFieldText(null);
    }
  }

  function handleFieldKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }

  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={() => step_(-step)}
        disabled={value <= min}
        aria-label={`Decrease ${ariaLabel}`}
      >
        −
      </button>
      <input
        type="text"
        inputMode="decimal"
        className={`w-14 ${FIELD_CLASS}`}
        value={focused ? fieldText : format(value)}
        onChange={handleFieldChange}
        onFocus={() => setFieldText(format(value))}
        onBlur={commit}
        onKeyDown={handleFieldKeyDown}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        className={BUTTON_CLASS}
        onClick={() => step_(step)}
        disabled={value >= max}
        aria-label={`Increase ${ariaLabel}`}
      >
        +
      </button>
      {unit && <span className="text-fleet-text-subtle text-xs">{unit}</span>}
    </span>
  );
}

// ── SegmentedControl ──────────────────────────────────────────────────────────

export function SegmentedControl<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  ariaLabel: string;
}): React.JSX.Element {
  const { value, options, onChange, ariaLabel } = props;

  return (
    <span role="radiogroup" aria-label={ariaLabel} className="flex items-center">
      {options.map((opt, i) => {
        const selected = opt.value === value;
        const isFirst = i === 0;
        const isLast = i === options.length - 1;

        const radiusClass = isFirst
          ? 'rounded-l rounded-r-none'
          : isLast
            ? 'rounded-r rounded-l-none'
            : 'rounded-none';

        const borderClass = isFirst ? 'border' : 'border border-l-0';

        const colorClass = selected
          ? 'bg-fleet-surface-2 text-fleet-text border-fleet-text-subtle'
          : 'text-fleet-text-secondary border-fleet-border-strong hover:border-fleet-text-subtle';

        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.label}
            className={`text-sm px-2 py-1 transition ${borderClass} ${radiusClass} ${colorClass}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </span>
  );
}
