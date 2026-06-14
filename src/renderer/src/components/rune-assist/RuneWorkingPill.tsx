type Props = {
  step: string | null;
  onStop: () => void;
};

export function RuneWorkingPill({ step, onStop }: Props): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-full border border-fleet-border bg-fleet-surface-2 px-3 py-1 text-xs text-neutral-200 shadow-lg">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
      <span className="text-neutral-300">Rune working…</span>
      {step && <span className="max-w-[12rem] truncate text-neutral-500">{step}</span>}
      <button
        onClick={onStop}
        className="ml-1 text-neutral-500 hover:text-neutral-200"
        aria-label="Stop"
      >
        ✕
      </button>
    </div>
  );
}
