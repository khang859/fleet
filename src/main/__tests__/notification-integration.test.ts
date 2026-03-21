import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../event-bus';
import { NotificationDetector } from '../notification-detector';
import { NotificationStateManager } from '../notification-state';

/**
 * Integration tests: NotificationDetector + NotificationStateManager + EventBus
 * working together as they would in the real main process.
 *
 * These test the full notification pipeline:
 *   PTY data → detector.scan() → eventBus 'notification' → state manager tracks it
 */
describe('Notification pipeline integration', () => {
  let eventBus: EventBus;
  let detector: NotificationDetector;
  let stateManager: NotificationStateManager;

  beforeEach(() => {
    eventBus = new EventBus();
    detector = new NotificationDetector(eventBus);
    stateManager = new NotificationStateManager(eventBus);
  });

  it('OSC 9 in PTY data → info state tracked for the pane', () => {
    detector.scan('pane-1', 'building...\x1b]9;build complete\x07');

    const state = stateManager.getState('pane-1');
    expect(state).toBeDefined();
    expect(state!.level).toBe('info');
    expect(state!.paneId).toBe('pane-1');
  });

  it('permission prompt in PTY data → permission state tracked', () => {
    detector.scan('pane-1', 'Do you want to allow this action? (y/n)');

    expect(stateManager.getState('pane-1')?.level).toBe('permission');
  });

  it('multiple panes receive independent notifications', () => {
    detector.scan('pane-1', '\x1b]9;task A done\x07');
    detector.scan('pane-2', 'Do you want to proceed? (y/n)');
    detector.scan('pane-3', 'normal output, no notification');

    expect(stateManager.getState('pane-1')?.level).toBe('info');
    expect(stateManager.getState('pane-2')?.level).toBe('permission');
    expect(stateManager.getState('pane-3')).toBeUndefined();
    expect(stateManager.getAllStates()).toHaveLength(2);
  });

  it('permission in one pane does not affect info in another', () => {
    detector.scan('pane-1', '\x1b]9;done\x07');
    detector.scan('pane-2', 'Do you want to allow this? (y/n)');

    // Each pane keeps its own level
    expect(stateManager.getState('pane-1')?.level).toBe('info');
    expect(stateManager.getState('pane-2')?.level).toBe('permission');
  });

  it('clearPane resets state, next scan re-populates', () => {
    detector.scan('pane-1', '\x1b]9;first notification\x07');
    expect(stateManager.getState('pane-1')?.level).toBe('info');

    stateManager.clearPane('pane-1');
    expect(stateManager.getState('pane-1')).toBeUndefined();

    // Another scan should create new state
    detector.scan('pane-1', 'Do you want to continue? (y/n)');
    expect(stateManager.getState('pane-1')?.level).toBe('permission');
  });

  it('pane-closed event clears notification state', () => {
    detector.scan('pane-1', '\x1b]9;done\x07');
    expect(stateManager.getState('pane-1')).toBeDefined();

    eventBus.emit('pane-closed', { type: 'pane-closed', paneId: 'pane-1' });

    expect(stateManager.getState('pane-1')).toBeUndefined();
  });

  it('pty-exit with non-zero code → error notification via event bus', () => {
    // Simulate what main/index.ts does: listen for pty-exit and emit notification
    eventBus.on('pty-exit', (event) => {
      const level = event.exitCode !== 0 ? 'error' : 'subtle';
      eventBus.emit('notification', {
        type: 'notification',
        paneId: event.paneId,
        level,
        timestamp: Date.now()
      });
    });

    eventBus.emit('pty-exit', { type: 'pty-exit', paneId: 'pane-1', exitCode: 1 });

    expect(stateManager.getState('pane-1')?.level).toBe('error');
  });

  it('pty-exit with zero code → subtle notification', () => {
    eventBus.on('pty-exit', (event) => {
      const level = event.exitCode !== 0 ? 'error' : 'subtle';
      eventBus.emit('notification', {
        type: 'notification',
        paneId: event.paneId,
        level,
        timestamp: Date.now()
      });
    });

    eventBus.emit('pty-exit', { type: 'pty-exit', paneId: 'pane-1', exitCode: 0 });

    expect(stateManager.getState('pane-1')?.level).toBe('subtle');
  });

  it('permission prompt after pty-exit error keeps the higher priority (error → permission upgrades)', () => {
    eventBus.on('pty-exit', (event) => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: event.paneId,
        level: event.exitCode !== 0 ? 'error' : 'subtle',
        timestamp: Date.now()
      });
    });

    eventBus.emit('pty-exit', { type: 'pty-exit', paneId: 'pane-1', exitCode: 1 });
    expect(stateManager.getState('pane-1')?.level).toBe('error');

    // Permission is higher priority than error, so it should upgrade
    detector.scan('pane-1', 'Do you want to allow this? (y/n)');
    expect(stateManager.getState('pane-1')?.level).toBe('permission');
  });

  it('info after error does NOT downgrade', () => {
    eventBus.on('pty-exit', (event) => {
      eventBus.emit('notification', {
        type: 'notification',
        paneId: event.paneId,
        level: event.exitCode !== 0 ? 'error' : 'subtle',
        timestamp: Date.now()
      });
    });

    eventBus.emit('pty-exit', { type: 'pty-exit', paneId: 'pane-1', exitCode: 1 });
    detector.scan('pane-1', '\x1b]9;done\x07'); // info — lower than error

    expect(stateManager.getState('pane-1')?.level).toBe('error');
  });

  it('event bus listener receives correct event shape from detector', () => {
    const listener = vi.fn();
    eventBus.on('notification', listener);

    detector.scan('pane-1', '\x1b]777;notify;Title;Body text\x07');

    expect(listener).toHaveBeenCalledWith({
      type: 'notification',
      paneId: 'pane-1',
      level: 'info',
      timestamp: expect.any(Number)
    });
  });
});
