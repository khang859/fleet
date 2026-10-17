const PAD = { sm: 'px-2 py-0.5', md: 'px-2.5 py-1' } as const;

/** A small segmented control: a few choices in a pill, one selected. */
export function PillRadio<T extends string | null>({
  label,
  value,
  options,
  onChange,
  size = 'sm',
  className = 'bg-fleet-surface'
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  size?: keyof typeof PAD;
  /** The pill's background, to sit against what is behind it. */
  className?: string;
}): React.JSX.Element {
  return (
    <span
      role="radiogroup"
      aria-label={label}
      className={`flex shrink-0 items-center gap-0.5 rounded-lg border border-fleet-border p-0.5 ${className}`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value ?? option.label}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`rounded-md ${PAD[size]} text-xs font-medium transition-colors focus-ring ${
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
