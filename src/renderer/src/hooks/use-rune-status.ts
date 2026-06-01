import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuneStatus } from '../../../shared/rune';

/**
 * Probes whether the `rune` binary is installed. Re-checks on mount and whenever the window
 * regains focus, so a user who installs Rune in a terminal sees the status flip without a
 * restart. `recheck` drives the manual "Re-check" buttons. `status` is null while loading.
 *
 * A monotonic token guards against races: only the most recent probe commits its result, so a
 * focus- or button-triggered re-check can never be overwritten by an older in-flight probe, and
 * a probe that resolves after unmount is ignored.
 */
export function useRuneStatus(): {
  status: RuneStatus | null;
  loading: boolean;
  recheck: () => void;
} {
  const [status, setStatus] = useState<RuneStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const recheck = useCallback(() => {
    const token = ++latest.current;
    setLoading(true);
    void window.fleet.rune.getVersion().then((s) => {
      if (token !== latest.current) return; // a newer probe (or unmount) superseded this one
      setStatus(s);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    recheck();
    const onFocus = (): void => recheck();
    window.addEventListener('focus', onFocus);
    return () => {
      // Bumping the shared ref (not a snapshot) is the point: it invalidates any in-flight
      // probe's closure so it can't setState after unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      latest.current++;
      window.removeEventListener('focus', onFocus);
    };
  }, [recheck]);

  return { status, loading, recheck };
}
