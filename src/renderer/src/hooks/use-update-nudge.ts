import { useEffect } from 'react';
import { useToastStore } from '../store/toast-store';
import { useUpdateStore } from '../store/update-store';

const LAST_TOAST_KEY = 'fleet:update-last-toast';

/** How long a nudge that was ignored stays quiet before saying it again. */
export const RE_TOAST_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * How often the "is the nudge due again" question gets asked.
 *
 * Coarse on purpose. It only has to notice that a day has passed on a window
 * nobody has touched, and an hour of slack on a 24-hour gap is not a difference
 * anyone can perceive.
 */
const RE_TOAST_POLL_MS = 60 * 60 * 1000;

export type LastToast = { version: string; at: number };

/**
 * Whether the nudge for `version` should be shown now.
 *
 * A version that has never been announced always gets said once. After that it
 * waits out {@link RE_TOAST_GAP_MS} - the update is not urgent and the pill in
 * the title strip is still sitting there saying so. A newer version landing on
 * top of an ignored one resets that: it is genuinely new information, and it is
 * also the case where the user has now been behind for a while.
 */
export function shouldToast(now: number, version: string, last: LastToast | null): boolean {
  if (last?.version !== version) return true;
  return now - last.at >= RE_TOAST_GAP_MS;
}

function readLastToast(): LastToast | null {
  try {
    const raw = localStorage.getItem(LAST_TOAST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, at } = parsed as Partial<LastToast>;
    if (typeof version !== 'string' || typeof at !== 'number') return null;
    return { version, at };
  } catch {
    return null;
  }
}

function writeLastToast(last: LastToast): void {
  try {
    localStorage.setItem(LAST_TOAST_KEY, JSON.stringify(last));
  } catch {
    // ignore storage errors
  }
}

/**
 * Keeps the update store fed, and says something when an update lands.
 *
 * Mounted once, from `App`. The toast is the half of the nudge that catches
 * someone who is at the keyboard; the pill it leaves behind is the half that
 * catches everyone else, which is why the toast is allowed to auto-dismiss and
 * why being missed entirely is not a failure.
 *
 * Persisted across reloads because the window outlives far more of them than it
 * does versions, and a nudge that started over on every reload would be the
 * thing users learned to ignore.
 */
export function useUpdateNudge(): void {
  useEffect(() => {
    const cleanup = window.fleet.updates.onUpdate((snapshot) => {
      useUpdateStore.getState().setSnapshot(snapshot);
    });
    // Main has been checking since launch and does not repeat itself, so a
    // renderer that just mounted - a reload, with an update already staged -
    // has to ask for what it missed.
    void window.fleet.updates.getSnapshot().then((snapshot) => {
      useUpdateStore.getState().setSnapshot(snapshot);
    });
    return () => {
      cleanup();
    };
  }, []);

  useEffect(() => {
    function nudge(): void {
      const update = useUpdateStore.getState().staged;
      if (!update) return;
      const now = Date.now();
      if (!shouldToast(now, update.version, readLastToast())) return;
      writeLastToast({ version: update.version, at: now });
      useToastStore.getState().show(`Fleet ${update.version} is ready to install`, {
        // Longer than the 4s default: this one is worth reading, and its action
        // restarts the app, which is not a button to put under a racing clock.
        duration: 10_000,
        action: {
          label: 'Restart to Update',
          onClick: () => window.fleet.updates.installUpdate()
        }
      });
    }

    const unsubscribe = useUpdateStore.subscribe(nudge);
    const timer = setInterval(nudge, RE_TOAST_POLL_MS);
    // An update that arrived before this mounted - a reload with one already
    // staged - never fires the subscription, so ask once on the way in.
    nudge();
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
}
