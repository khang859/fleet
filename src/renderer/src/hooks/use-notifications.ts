import { useEffect } from 'react';
import { useNotificationStore } from '../store/notification-store';
import { useSettingsStore } from '../store/settings-store';
import { playChime } from '../lib/chime';

export function useNotifications(): void {
  const { setNotification, setActivity } = useNotificationStore();

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

  // Subscribe to activity state changes (new). This is the single source of
  // truth for the in-app chime: main only emits a state change on an actual
  // transition (see ActivityTracker.setState's dedup), so `needs_me`/`error`
  // here already mean "just became blocked/failed", not "still is". A
  // permission prompt bridges to `needs_me` via the same underlying event in
  // main, so chiming here (instead of also on the raw `notification` event
  // above) avoids a double beep for one occurrence.
  //
  // Agent panes have no PTY and so never reach main's tracker; they report
  // themselves from the agent store, and ring the same chime from there.
  useEffect(() => {
    const cleanup = window.fleet.activity.onStateChange((payload) => {
      setActivity({
        paneId: payload.paneId,
        state: payload.state,
        lastOutputAt: payload.lastOutputAt,
        timestamp: payload.timestamp
      });

      const notifications = useSettingsStore.getState().settings?.notifications;
      const shouldChime =
        (payload.state === 'needs_me' && notifications?.needsPermission.sound) ||
        (payload.state === 'error' && notifications?.processExitError.sound);
      if (shouldChime) playChime();
    });
    return () => {
      cleanup();
    };
  }, [setActivity]);
}
