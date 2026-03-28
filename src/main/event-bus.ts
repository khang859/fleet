import { EventEmitter } from 'events';
import type { NotificationLevel, ActivityState } from '../shared/types';

export type FleetEvent =
  | { type: 'notification'; paneId: string; level: NotificationLevel; timestamp: number }
  | { type: 'pane-created'; paneId: string }
  | { type: 'pane-closed'; paneId: string }
  | { type: 'pty-exit'; paneId: string; exitCode: number }
  | { type: 'activity-state-change'; paneId: string; state: ActivityState; lastOutputAt: number; timestamp: number }
  | { type: 'command-started'; paneId: string; timestamp: number }
  | { type: 'workspace-loaded'; workspaceId: string }
  | { type: 'cwd-changed'; paneId: string; cwd: string; source: 'osc7' | 'poll' };

type EventMap = {
  [K in FleetEvent['type']]: Extract<FleetEvent, { type: K }>;
};

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }
}
