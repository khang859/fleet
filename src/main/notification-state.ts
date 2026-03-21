import type { EventBus } from './event-bus';
import type { NotificationLevel } from '../shared/types';

type NotificationRecord = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

const PRIORITY: Record<NotificationLevel, number> = {
  permission: 3,
  error: 2,
  info: 1,
  subtle: 0
};

export class NotificationStateManager {
  private states = new Map<string, NotificationRecord>();

  constructor(eventBus: EventBus) {
    eventBus.on('notification', (event) => {
      const existing = this.states.get(event.paneId);
      if (!existing || PRIORITY[event.level] >= PRIORITY[existing.level]) {
        this.states.set(event.paneId, {
          paneId: event.paneId,
          level: event.level,
          timestamp: event.timestamp
        });
      }
    });

    eventBus.on('pane-closed', (event) => {
      this.states.delete(event.paneId);
    });
  }

  getState(paneId: string): NotificationRecord | undefined {
    return this.states.get(paneId);
  }

  getAllStates(): NotificationRecord[] {
    return Array.from(this.states.values());
  }

  clearPane(paneId: string): void {
    this.states.delete(paneId);
  }
}
