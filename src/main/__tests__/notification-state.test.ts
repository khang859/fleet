import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationStateManager } from '../notification-state';
import { EventBus } from '../event-bus';

describe('NotificationStateManager', () => {
  let eventBus: EventBus;
  let manager: NotificationStateManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new NotificationStateManager(eventBus);
  });

  it('tracks notification state per pane', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: 1000
    });

    expect(manager.getState('pane-1')).toEqual({
      paneId: 'pane-1',
      level: 'permission',
      timestamp: 1000
    });
  });

  it('clears notification state when pane is focused', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000
    });

    manager.clearPane('pane-1');

    expect(manager.getState('pane-1')).toBeUndefined();
  });

  it('keeps highest priority notification per pane', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000
    });

    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: 2000
    });

    expect(manager.getState('pane-1')?.level).toBe('permission');
  });

  it('returns all active notifications', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000
    });
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-2',
      level: 'permission',
      timestamp: 2000
    });

    const all = manager.getAllStates();
    expect(all).toHaveLength(2);
  });

  it('clears state when pane is closed', () => {
    eventBus.emit('notification', {
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: 1000
    });

    eventBus.emit('pane-closed', { type: 'pane-closed', paneId: 'pane-1' });

    expect(manager.getState('pane-1')).toBeUndefined();
  });
});
