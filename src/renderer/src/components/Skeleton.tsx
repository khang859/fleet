/** Generic shimmer placeholder block. Pair with `useDelayedFlag` so it only
 * shows for genuinely slow operations (~1.5s+) rather than flashing on every load. */
export function Skeleton({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <div className={`animate-pulse rounded bg-fleet-surface-3 ${className}`} aria-hidden="true" />
  );
}
