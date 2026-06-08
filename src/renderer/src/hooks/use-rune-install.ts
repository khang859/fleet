import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuneInstallResult } from '../../../shared/rune';

/**
 * Drives the "Install Rune" / "Update" buttons in the Settings → Rune section. Runs the install
 * script via the main process, tracks a single in-flight run, and exposes the last outcome so the
 * UI can show a success message (install vs. update, version delta) or the error. `onDone` fires
 * after a run so the caller can re-probe the install status (the green/amber badge).
 *
 * The install can take up to ~2 minutes, so guard the async tail: `inFlight` drops concurrent
 * triggers and `mounted` prevents committing state (or re-probing) after the section unmounts —
 * mirroring the token guard in `use-rune-status`.
 */
export function useRuneInstall(onDone: () => void): {
  install: () => void;
  running: boolean;
  result: RuneInstallResult | null;
  error: string | null;
} {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RuneInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const install = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    setResult(null);
    void window.fleet.rune
      .install()
      .then((r) => {
        if (mounted.current) setResult(r);
      })
      .catch((err: unknown) => {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) {
          setRunning(false);
          onDone();
        }
      });
  }, [onDone]);

  return { install, running, result, error };
}
