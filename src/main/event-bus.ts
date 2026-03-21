import { EventEmitter } from 'events';
import type { NotificationLevel } from '../shared/types';

export type FleetEvent =
  | { type: 'notification'; paneId: string; level: NotificationLevel; timestamp: number }
  | { type: 'pane-created'; paneId: string }
  | { type: 'pane-closed'; paneId: string }
  | { type: 'pty-exit'; paneId: string; exitCode: number }
  | { type: 'agent-state-change'; paneId: string; state: string; tool?: string }
  | {
      type: 'admiral-state-change';
      state: 'standby' | 'thinking' | 'speaking' | 'alert';
      statusText: string;
    }
  | { type: 'workspace-loaded'; workspaceId: string }
  | { type: 'cwd-changed'; paneId: string; cwd: string }
  | { type: 'starbase-changed' };

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
