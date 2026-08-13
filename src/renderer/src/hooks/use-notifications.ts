import { useEffect } from 'react';
import { useNotificationStore } from '../store/notification-store';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useAgentStore } from '../store/agent-store';
import { playChime } from '../lib/chime';

export function useNotifications(): void {
  /*
   * Actions only. This hook runs inside `App`, and the notification store
   * replaces its `notifications`/`activities` maps wholesale on every set, so
   * subscribing to the whole store here re-renders every pane on each activity
   * tick - exactly what the comment above `MiniTabStatus` in App.tsx warns
   * against. Selecting the two setters subscribes to nothing that changes.
   */
  const setNotification = useNotificationStore((s) => s.setNotification);
  const setActivity = useNotificationStore((s) => s.setActivity);

  // Subscribe to notification events (existing)
  useEffect(() => {
    const cleanup = window.fleet.notifications.onNotification((payload) => {
      setNotification({
        paneId: payload.paneId,
        level: payload.level,
        timestamp: payload.timestamp
      });
    });
    return () => {
      cleanup();
    };
  }, [setNotification]);

  // Subscribe to activity state changes. This is live state for the sidebar,
  // the tab badges and the palette; how loudly any of it is announced is not
  // decided here (see the chime below).
  useEffect(() => {
    const cleanup = window.fleet.activity.onStateChange((payload) => {
      setActivity({
        paneId: payload.paneId,
        state: payload.state,
        lastOutputAt: payload.lastOutputAt,
        timestamp: payload.timestamp
      });
    });
    return () => {
      cleanup();
    };
  }, [setActivity]);

  /*
   * The chime rings when main says so, rather than whenever a pane changes
   * state.
   *
   * How loud an event should be depends on where the user is, and that answer
   * is split across the two processes: only main knows whether the window is
   * focused, only the renderer knows which panes are on screen. Main holds the
   * rule, so the same event cannot be judged twice and differently - and so a
   * desktop notification, which rings on its own, is never doubled by a chime
   * for the same news.
   */
  useEffect(() => {
    return window.fleet.activity.onChime(() => playChime());
  }, []);

  /*
   * Tell main what the user can see.
   *
   * Every tab stays mounted and inactive ones are hidden with `display: none`,
   * so being rendered is not being visible: the panes of the active tab are.
   */
  useEffect(() => {
    let last = '';
    const publish = (): void => {
      const state = useWorkspaceStore.getState();
      const tab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      const paneIds = tab === undefined ? [] : collectPaneIds(tab.splitRoot);
      // Sent on any workspace change, which is most of them, so an unchanged
      // set is dropped here rather than crossing the bridge to be ignored.
      const key = paneIds.join(',');
      if (key !== last) {
        last = key;
        window.fleet.activity.visiblePanes(paneIds);
      }
      // What is on screen in a focused window has been seen. Only agent panes
      // are told: a terminal's state belongs to main, which watches the process
      // and would put back anything cleared behind its back.
      if (!document.hasFocus()) return;
      const markSeen = useAgentStore.getState().markSeen;
      for (const paneId of paneIds) markSeen(paneId);
    };
    publish();
    const unsubscribe = useWorkspaceStore.subscribe(publish);
    // Coming back to the window is the other way a pane becomes seen, and it
    // moves no panes at all.
    window.addEventListener('focus', publish);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', publish);
    };
  }, []);
}
