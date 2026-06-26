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
      <div aria-live="polite" className="mt-1 text-xs text-fleet-text-muted">
        {shown} ({elapsed}s)
      </div>
    </div>
  );
}
