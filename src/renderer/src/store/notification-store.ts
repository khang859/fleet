import { create } from 'zustand';
import type { NotificationLevel } from '../../../shared/types';

type NotificationRecord = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

type NotificationStore = {
  notifications: Map<string, NotificationRecord>;
  setNotification: (record: NotificationRecord) => void;
  clearPane: (paneId: string) => void;
  getTabBadge: (paneIds: string[]) => NotificationLevel | null;
};

const PRIORITY: Record<NotificationLevel, number> = {
  permission: 3,
  error: 2,
  info: 1,
  subtle: 0,
};

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: new Map(),

  setNotification: (record) => {
    set((state) => {
      const next = new Map(state.notifications);
      const existing = next.get(record.paneId);
      if (!existing || PRIORITY[record.level] >= PRIORITY[existing.level]) {
        next.set(record.paneId, record);
      }
      return { notifications: next };
    });
  },

  clearPane: (paneId) => {
    set((state) => {
      const next = new Map(state.notifications);
      next.delete(paneId);
      return { notifications: next };
    });
  },

  getTabBadge: (paneIds) => {
    const { notifications } = get();
    let highest: NotificationLevel | null = null;
    let highestPriority = -1;

    for (const paneId of paneIds) {
      const record = notifications.get(paneId);
      if (record && PRIORITY[record.level] > highestPriority) {
        highest = record.level;
        highestPriority = PRIORITY[record.level];
      }
    }
    return highest;
  },
}));
