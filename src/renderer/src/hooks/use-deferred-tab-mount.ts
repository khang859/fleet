import { useCallback, useEffect, useState } from 'react';

/** Upper bound on how long a release waits for an idle slice before it runs anyway. */
const IDLE_TIMEOUT_MS = 200;

/**
 * Picks the next tab waiting to be mounted, or `undefined` when none are.
 *
 * The active tab is never pending: it mounts synchronously so the first frame
 * shows real content.
 */
export function nextPendingTabId(
  orderedTabIds: readonly string[],
  activeTabId: string | null,
  released: ReadonlySet<string>
): string | undefined {
  return orderedTabIds.find((id) => id !== activeTabId && !released.has(id));
}

/**
 * Releases tabs for mounting one at a time, after the first frame.
 *
 * Every tab of every workspace used to mount its panes before the window was
 * first painted, so a user with many tabs paid ~40ms of main-thread work per
 * pane up front (#621). Here the active tab still mounts synchronously and the
 * rest are released one per idle callback, so they all end up mounted without
 * blocking the first paint.
 *
 * Nothing is ever unmounted. An unmounted pane silently drops its PTY output,
 * which is why #595 is a separate, larger problem.
 *
 * `orderedTabIds` sets the release order and may grow later - background
 * workspaces load after boot, and their tabs simply join the back of the queue.
 *
 * Returns a predicate: `true` once the tab is cleared to mount.
 */
export function useDeferredTabMount(
  orderedTabIds: readonly string[],
  activeTabId: string | null
): (tabId: string) => boolean {
  const [released, setReleased] = useState<ReadonlySet<string>>(() => new Set());

  // The active tab mounts without waiting its turn, so record it as released.
  // Otherwise switching away from it would take its panes back down.
  useEffect(() => {
    if (activeTabId === null || released.has(activeTabId)) return;
    setReleased((prev) => new Set(prev).add(activeTabId));
  }, [activeTabId, released]);

  const pending = nextPendingTabId(orderedTabIds, activeTabId, released);

  // Releasing one tab re-renders, which picks the next one and schedules again,
  // so the queue drains a tab per idle slice until it is empty.
  useEffect(() => {
    if (pending === undefined) return;
    const handle = requestIdleCallback(() => setReleased((prev) => new Set(prev).add(pending)), {
      timeout: IDLE_TIMEOUT_MS
    });
    return () => cancelIdleCallback(handle);
  }, [pending]);

  return useCallback(
    (tabId: string) => tabId === activeTabId || released.has(tabId),
    [activeTabId, released]
  );
}
