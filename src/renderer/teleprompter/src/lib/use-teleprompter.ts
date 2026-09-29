import { useEffect, useState } from 'react';
import type { TeleprompterApi } from '../../../../preload/teleprompter';
import type { TeleprompterState } from '../../../../shared/teleprompter';

declare global {
  interface Window {
    teleprompter: TeleprompterApi;
  }
}

/** Main's teleprompter state, kept current by its pushes. Null until the first arrives. */
export function useTeleprompterState(): TeleprompterState | null {
  const [state, setState] = useState<TeleprompterState | null>(null);
  useEffect(() => {
    const unsubscribe = window.teleprompter.onState(setState);
    // A push can land before this answer does, and is then the newer of the two.
    void window.teleprompter.getState().then((initial) => setState((prev) => prev ?? initial));
    return unsubscribe;
  }, []);
  return state;
}

/** Milliseconds since `startedAt`, ticking once a second, or null while the timer is not running. */
export function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const tick = (): void => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? null : Math.max(0, now - startedAt);
}
