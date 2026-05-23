import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pid-cwd', () => ({
  default: vi.fn().mockResolvedValue('/tmp/test-cwd')
}));

vi.mock('fs/promises', () => ({
  readlink: vi.fn().mockResolvedValue('/tmp/test-cwd')
}));

import { CwdPoller } from '../cwd-poller';
import { EventBus } from '../event-bus';
import type { PtyManager } from '../pty-manager';
import pidCwd from 'pid-cwd';

function makeMockPtyManager(cwd = '/old-cwd'): PtyManager {
  return {
    getCwd: vi.fn().mockReturnValue(cwd),
    updateCwd: vi.fn(),
    getPid: vi.fn().mockReturnValue(999),
    paneIds: vi.fn().mockReturnValue([]),
    has: vi.fn().mockReturnValue(true)
  } as unknown as PtyManager;
}

describe('CwdPoller', () => {
  let eventBus: EventBus;
  let poller: CwdPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
  });

  afterEach(() => {
    poller?.stopAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('resolves cwd via platform-specific method', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd');
    poller = new CwdPoller(eventBus, ptyManager);
    poller.startPolling('pane-1', 999);

    await vi.advanceTimersByTimeAsync(5001);

    if (process.platform === 'darwin') {
      expect(pidCwd).toHaveBeenCalledWith(999);
    } else {
      const { readlink } = await import('fs/promises');
      expect(readlink).toHaveBeenCalledWith('/proc/999/cwd');
    }
  });

  it('emits cwd-changed when cwd differs', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd');
    poller = new CwdPoller(eventBus, ptyManager);

    const changes: string[] = [];
    eventBus.on('cwd-changed', (e) => changes.push(e.cwd));

    poller.startPolling('pane-1', 999);
    await vi.advanceTimersByTimeAsync(5001);

    expect(changes).toContain('/tmp/test-cwd');
  });

  it('stopPolling clears the timer', async () => {
    const ptyManager = makeMockPtyManager('/old-cwd');
    poller = new CwdPoller(eventBus, ptyManager);

    poller.startPolling('pane-1', 999);
    poller.stopPolling('pane-1');

    await vi.advanceTimersByTimeAsync(10000);

    expect(pidCwd).not.toHaveBeenCalled();
  });
});

describe('CwdPoller on win32', () => {
  const originalPlatform = process.platform;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    eventBus = new EventBus();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('uses pid-cwd to resolve cwd for win32 panes', async () => {
    const ptyManager = makeMockPtyManager('C:\\old');
    const poller = new CwdPoller(eventBus, ptyManager);
    poller.startPolling('pane-1', 999, 'win32');

    await vi.advanceTimersByTimeAsync(5001);

    expect(pidCwd).toHaveBeenCalledWith(999);
    poller.stopAll();
  });

  it('does not poll WSL panes (waits for OSC 7)', async () => {
    const ptyManager = makeMockPtyManager('C:\\old');
    const poller = new CwdPoller(eventBus, ptyManager);
    poller.startPolling('pane-wsl', 999, { kind: 'wsl', distro: 'Ubuntu' });

    await vi.advanceTimersByTimeAsync(10000);

    expect(pidCwd).not.toHaveBeenCalled();
    poller.stopAll();
  });
});
