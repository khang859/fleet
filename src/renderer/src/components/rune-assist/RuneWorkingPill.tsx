import { useEffect, useState } from 'react';

type Props = {
  step: string | null;
  startedAt: number | null;
  onStop: () => void;
};

export function RuneWorkingPill({ step, startedAt, onStop }: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  return (
    <div className="flex items-center gap-2 rounded-full border border-fleet-border bg-fleet-surface-2 px-3 py-1 text-xs text-neutral-200 shadow-lg">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
      <span className="text-neutral-300">Rune working…</span>
      <span className="tabular-nums text-neutral-400">{elapsed}s</span>
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
