/**
 * Instant-apply switch (NN/g: toggles reflect a state change immediately, never
 * gated behind a Save). Uses the accent color when on; reduced-motion users get
 * the press-scale neutralized via index.css.
 */
export function Toggle({
  checked,
  onChange,
  id,
  ariaLabel
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  /** Only needed when the Toggle is used without an associated <label htmlFor>. */
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors active:scale-95 ${
        checked ? 'fleet-accent-bg' : 'bg-fleet-surface-3'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
