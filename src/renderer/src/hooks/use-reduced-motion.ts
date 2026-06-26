import { useEffect, useState } from 'react';

const query = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Tracks the user's `prefers-reduced-motion` setting, updating if it changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(query.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
