import { useEffect, useState } from 'react';

export type PresenceState = 'open' | 'closed';

/**
 * Keeps content mounted through its exit animation, mirroring what Radix's
 * Presence does for our hand-rolled overlays. While `open` is true the node is
 * mounted with state `'open'` (plays the enter animation). When `open` flips to
 * false the state becomes `'closed'` (plays the exit animation) and the node is
 * unmounted only after `exitMs` elapses.
 *
 * `exitMs` must match the CSS exit-animation duration so the node isn't removed
 * mid-animation.
 */
export function usePresence(
  open: boolean,
  exitMs = 150
): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? 'open' : 'closed');

  useEffect(() => {
    if (open) {
      setMounted(true);
      setState('open');
      return;
    }
    setState('closed');
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);

  return { mounted, state };
}
