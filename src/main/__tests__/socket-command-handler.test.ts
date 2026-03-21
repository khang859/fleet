import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FleetCommandHandler } from '../socket-command-handler';
import { PtyManager } from '../pty-manager';
import { LayoutStore } from '../layout-store';
import { EventBus } from '../event-bus';
import { NotificationStateManager } from '../notification-state';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }))
}));

vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private data: Record<string, unknown> = {};
      constructor() {}
      get(key: string, defaultVal?: unknown) {
        return this.data[key] ?? defaultVal;
      }
      set(key: string, value: unknown) {
        this.data[key] = value;
      }
      delete(key: string) {
        delete this.data[key];
      }
    }
  };
});

describe('FleetCommandHandler', () => {
  let handler: FleetCommandHandler;
  let ptyManager: PtyManager;
  let layoutStore: LayoutStore;
  let eventBus: EventBus;

  beforeEach(() => {
    ptyManager = new PtyManager();
    layoutStore = new LayoutStore();
    eventBus = new EventBus();
    const notificationState = new NotificationStateManager(eventBus);
    handler = new FleetCommandHandler(ptyManager, layoutStore, eventBus, notificationState);
  });

  it('handles list-workspaces', async () => {
    const result = await handler.handleCommand({ type: 'list-workspaces' });
    expect(result.ok).toBe(true);
    expect(result.workspaces).toEqual([]);
  });

  it('handles new-tab', async () => {
    const result = await handler.handleCommand({
      type: 'new-tab',
      label: 'test',
      cmd: 'echo hello',
      cwd: '/tmp'
    });
    expect(result.ok).toBe(true);
    expect(result.tabId).toBeDefined();
    expect(result.paneId).toBeDefined();
  });

  it('handles list-panes after new-tab', async () => {
    const tabResult = await handler.handleCommand({
      type: 'new-tab',
      label: 'test',
      cwd: '/tmp'
    });
    const result = await handler.handleCommand({
      type: 'list-panes',
      tabId: tabResult.tabId
    });
    expect(result.ok).toBe(true);
    expect(result.panes).toHaveLength(1);
  });

  it('handles get-state', async () => {
    const result = await handler.handleCommand({ type: 'get-state' });
    expect(result.ok).toBe(true);
    expect(result.workspace).toBeDefined();
    expect(result.notifications).toBeDefined();
  });

  it('returns error for unknown command', async () => {
    const result = await handler.handleCommand({ type: 'nonexistent' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown command');
  });

  it('returns error for invalid paneId', async () => {
    const result = await handler.handleCommand({
      type: 'focus-pane',
      paneId: 'does-not-exist'
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});
