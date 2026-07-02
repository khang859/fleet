import { useEffect, useState } from 'react';

/**
 * Debounces a boolean so it only flips to `true` after `active` has held
 * `true` continuously for `delayMs`. Used to gate loading skeletons: fast
 * operations stay optimistic/instant, only genuinely slow ones show a
 * shimmer. Flips back to `false` immediately once `active` goes false.
 */
export function useDelayedFlag(active: boolean, delayMs = 1500): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return show;
}
