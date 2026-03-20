import { useEffect } from 'react';
import { useNotificationStore } from '../store/notification-store';

export function useNotifications() {
  const { setNotification } = useNotificationStore();

  useEffect(() => {
    const cleanup = window.fleet.notifications.onNotification((payload) => {
      setNotification({
        paneId: payload.paneId,
        level: payload.level,
        timestamp: payload.timestamp,
      });
    });
    return () => { cleanup(); };
  }, [setNotification]);
}
