import { describe, it, expect, vi } from 'vitest';
import { EventBus, FleetEvent } from '../event-bus';

describe('EventBus', () => {
  it('emits and receives typed events', () => {
    const bus = new EventBus();
    const callback = vi.fn();
    bus.on('notification', callback);

    const event: FleetEvent = {
      type: 'notification',
      paneId: 'pane-1',
      level: 'permission',
      timestamp: Date.now()
    };
    bus.emit('notification', event);

    expect(callback).toHaveBeenCalledWith(event);
  });

  it('supports multiple listeners on the same event', () => {
    const bus = new EventBus();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.on('notification', cb1);
    bus.on('notification', cb2);

    bus.emit('notification', { type: 'notification', paneId: 'p', level: 'info', timestamp: 0 });

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  it('removes a listener with off()', () => {
    const bus = new EventBus();
    const callback = vi.fn();
    bus.on('notification', callback);
    bus.off('notification', callback);

    bus.emit('notification', { type: 'notification', paneId: 'p', level: 'info', timestamp: 0 });

    expect(callback).not.toHaveBeenCalled();
  });

  it('emits pane lifecycle events', () => {
    const bus = new EventBus();
    const callback = vi.fn();
    bus.on('pane-created', callback);

    bus.emit('pane-created', { type: 'pane-created', paneId: 'pane-1' });

    expect(callback).toHaveBeenCalledWith({ type: 'pane-created', paneId: 'pane-1' });
  });
});
