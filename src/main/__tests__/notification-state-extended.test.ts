import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationStateManager } from '../notification-state';
import { EventBus } from '../event-bus';

describe('NotificationStateManager — extended', () => {
  let eventBus: EventBus;
  let manager: NotificationStateManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new NotificationStateManager(eventBus);
  });

  describe('priority enforcement', () => {
    it('does NOT downgrade from permission to info', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'permission',
        timestamp: 1000
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 2000
      });

      expect(manager.getState('p1')?.level).toBe('permission');
      expect(manager.getState('p1')?.timestamp).toBe(1000); // timestamp didn't change
    });

    it('does NOT downgrade from error to info', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'error',
        timestamp: 1000
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 2000
      });

      expect(manager.getState('p1')?.level).toBe('error');
    });

    it('does NOT downgrade from error to subtle', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'error',
        timestamp: 1000
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'subtle',
        timestamp: 2000
      });

      expect(manager.getState('p1')?.level).toBe('error');
    });

    it('upgrades from subtle → info → error → permission', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'subtle',
        timestamp: 1
      });
      expect(manager.getState('p1')?.level).toBe('subtle');

      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 2
      });
      expect(manager.getState('p1')?.level).toBe('info');

      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'error',
        timestamp: 3
      });
      expect(manager.getState('p1')?.level).toBe('error');

      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'permission',
        timestamp: 4
      });
      expect(manager.getState('p1')?.level).toBe('permission');
    });

    it('updates timestamp on equal-priority re-notification', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 1000
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 5000
      });

      expect(manager.getState('p1')?.timestamp).toBe(5000);
    });
  });

  describe('multi-pane state isolation', () => {
    it('clearing one pane does not affect another', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'error',
        timestamp: 1
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p2',
        level: 'permission',
        timestamp: 2
      });

      manager.clearPane('p1');

      expect(manager.getState('p1')).toBeUndefined();
      expect(manager.getState('p2')?.level).toBe('permission');
    });

    it('pane-closed event for one pane does not affect others', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 1
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p2',
        level: 'info',
        timestamp: 2
      });

      eventBus.emit('pane-closed', { type: 'pane-closed', paneId: 'p1' });

      expect(manager.getAllStates()).toHaveLength(1);
      expect(manager.getState('p2')).toBeDefined();
    });

    it('getAllStates reflects clearPane calls', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 1
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p2',
        level: 'error',
        timestamp: 2
      });
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p3',
        level: 'permission',
        timestamp: 3
      });

      manager.clearPane('p2');

      const states = manager.getAllStates();
      expect(states).toHaveLength(2);
      expect(states.map((s) => s.paneId).sort()).toEqual(['p1', 'p3']);
    });
  });

  describe('edge cases', () => {
    it('clearPane on non-existent pane is a no-op', () => {
      manager.clearPane('ghost');
      expect(manager.getAllStates()).toHaveLength(0);
    });

    it('getState returns undefined for unknown pane', () => {
      expect(manager.getState('ghost')).toBeUndefined();
    });

    it('can re-notify after clearing', () => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'permission',
        timestamp: 1
      });
      manager.clearPane('p1');
      expect(manager.getState('p1')).toBeUndefined();

      // New notification after clear should be tracked
      eventBus.emit('notification', {
        type: 'notification',
        paneId: 'p1',
        level: 'info',
        timestamp: 2
      });
      expect(manager.getState('p1')?.level).toBe('info');
    });
  });
});
