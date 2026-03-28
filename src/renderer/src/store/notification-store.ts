import { create } from 'zustand';
import type { NotificationLevel, ActivityState } from '../../../shared/types';
import { createLogger } from '../logger';

const log = createLogger('store:notifications');

type NotificationRecord = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

type ActivityRecord = {
  paneId: string;
  state: ActivityState;
  lastOutputAt: number;
  timestamp: number;
};

type NotificationStore = {
  notifications: Map<string, NotificationRecord>;
  activities: Map<string, ActivityRecord>;
  setNotification: (record: NotificationRecord) => void;
  setActivity: (record: ActivityRecord) => void;
  clearPane: (paneId: string) => void;
  getTabBadge: (paneIds: string[]) => NotificationLevel | null;
  getActivity: (paneId: string) => ActivityRecord | undefined;
  getTabActivity: (paneIds: string[]) => ActivityRecord | undefined;
};

const PRIORITY: Record<NotificationLevel, number> = {
  permission: 3,
  error: 2,
  info: 1,
  subtle: 0
};

/** Map activity states to notification badge levels for the tab sidebar. */
function activityToBadge(state: ActivityState): NotificationLevel | null {
  switch (state) {
    case 'needs_me': return 'permission';
    case 'error': return 'error';
    case 'done': return 'info';
    case 'working': return 'subtle';
    case 'idle': return null;
  }
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: new Map(),
  activities: new Map(),

  setNotification: (record) => {
    log.debug('setNotification', { paneId: record.paneId, level: record.level });
    set((state) => {
      const next = new Map(state.notifications);
      const existing = next.get(record.paneId);
      if (!existing || PRIORITY[record.level] >= PRIORITY[existing.level]) {
        next.set(record.paneId, record);
      }
      return { notifications: next };
    });
  },

  setActivity: (record) => {
    log.debug('setActivity', { paneId: record.paneId, state: record.state });
    set((state) => {
      const next = new Map(state.activities);
      next.set(record.paneId, record);
      return { activities: next };
    });
  },

  clearPane: (paneId) => {
    log.debug('clearPane', { paneId });
    set((state) => {
      const nextNotif = new Map(state.notifications);
      nextNotif.delete(paneId);
      // Don't clear activity — it's live state from ActivityTracker,
      // not a dismissable notification
      return { notifications: nextNotif };
    });
  },

  getTabBadge: (paneIds) => {
    const { notifications, activities } = get();
    let highest: NotificationLevel | null = null;
    let highestPriority = -1;

    for (const paneId of paneIds) {
      // Check activity-based badges first
      const activity = activities.get(paneId);
      if (activity) {
        const badge = activityToBadge(activity.state);
        if (badge && PRIORITY[badge] > highestPriority) {
          highest = badge;
          highestPriority = PRIORITY[badge];
        }
      }

      // Check notification-based badges (existing behavior)
      const record = notifications.get(paneId);
      if (record && PRIORITY[record.level] > highestPriority) {
        highest = record.level;
        highestPriority = PRIORITY[record.level];
      }
    }
    return highest;
  },

  getActivity: (paneId) => {
    return get().activities.get(paneId);
  },

  getTabActivity: (paneIds) => {
    const { activities } = get();
    // Return the most recent activity across all panes in the tab
    let latest: ActivityRecord | undefined;
    for (const paneId of paneIds) {
      const record = activities.get(paneId);
      if (record && (!latest || record.timestamp > latest.timestamp)) {
        latest = record;
      }
    }
    return latest;
  },
}));
