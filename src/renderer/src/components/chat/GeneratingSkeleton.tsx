import { useEffect, useState } from 'react';

export function GeneratingSkeleton({ label }: { label: string }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const shown = elapsed >= 10 ? 'Still working — this can take ~30s' : label;
  return (
    <div className="px-4 py-2">
      <div className="aspect-square w-64 max-w-full animate-pulse rounded-lg bg-fleet-surface-3" />
      <div className="mt-1 text-xs text-fleet-text-muted">
        {/* Only the evolving label is announced; the per-second counter stays out
            of the live region so screen readers don't read it every tick. */}
        <span aria-live="polite">{shown}</span> <span aria-hidden="true">({elapsed}s)</span>
      </div>
    </div>
  );
}
