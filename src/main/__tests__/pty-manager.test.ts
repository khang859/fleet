import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyManager } from '../pty-manager';

// Mock node-pty since we can't spawn real PTYs in unit tests
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }))
}));

describe('PtyManager', () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager();
  });

  it('creates a PTY and stores it by paneId', () => {
    const result = manager.create({
      paneId: 'pane-1',
      cwd: '/tmp',
      shell: '/bin/zsh'
    });
    expect(result.paneId).toBe('pane-1');
    expect(result.pid).toBe(12345);
    expect(manager.has('pane-1')).toBe(true);
  });

  it('kills a PTY and removes it from the map', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.kill('pane-1');
    expect(manager.has('pane-1')).toBe(false);
  });

  it('returns all active pane IDs', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.create({ paneId: 'pane-2', cwd: '/tmp', shell: '/bin/zsh' });
    expect(manager.paneIds()).toEqual(['pane-1', 'pane-2']);
  });

  it('returns existing PTY info when creating a duplicate paneId (idempotent for HMR)', () => {
    const first = manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const second = manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    expect(second.paneId).toBe('pane-1');
    expect(second.pid).toBe(first.pid);
    expect(manager.has('pane-1')).toBe(true);
  });
});

import * as ptyModule from 'node-pty';

describe('PtyManager batching and cleanup', () => {
  let manager: PtyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PtyManager();
  });

  afterEach(() => {
    manager.killAll();
    vi.useRealTimers();
  });

  it('batches onData output and flushes after 16ms', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });

    const received: string[] = [];
    manager.onData('pane-1', (data) => received.push(data));

    // Get the callback registered on the mock PTY
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    ptyDataCallback('hello ');
    ptyDataCallback('world');

    // Not flushed yet
    expect(received).toHaveLength(0);

    // After 16ms flush
    vi.advanceTimersByTime(16);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('hello world');
  });

  it('disposes data listener when pane is killed', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const disposable = mockPty.onData.mock.results[0].value;

    manager.onData('pane-1', vi.fn());
    manager.kill('pane-1');

    expect(disposable.dispose).toHaveBeenCalled();
  });

  it('calls pty.pause when buffer exceeds 256KB', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    manager.onData('pane-1', vi.fn());

    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    const ptyDataCallback = mockPty.onData.mock.calls[0][0];

    // Send >256KB of data
    ptyDataCallback('x'.repeat(257 * 1024));

    expect(mockPty.pause).toHaveBeenCalled();
  });

  it('resume calls pty.resume', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    manager.resume('pane-1');

    expect(mockPty.resume).toHaveBeenCalled();
  });

  it('disposes previous exitDisposable when onExit is called again', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    mockPty.onExit
      .mockReturnValueOnce({ dispose: firstDispose })
      .mockReturnValueOnce({ dispose: secondDispose });

    manager.onExit('pane-1', vi.fn());
    // Second registration should dispose the first listener
    manager.onExit('pane-1', vi.fn());

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
  });

  it('does not fire duplicate exit callbacks when onExit is re-registered', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    const mockPty = (ptyModule.spawn as ReturnType<typeof vi.fn>).mock.results[0].value;

    // Track which callbacks get registered on the mock PTY
    const registeredCallbacks: Array<(e: { exitCode: number }) => void> = [];
    mockPty.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => {
      registeredCallbacks.push(cb);
      return { dispose: vi.fn() };
    });

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    manager.onExit('pane-1', firstCallback);
    manager.onExit('pane-1', secondCallback);

    // Simulate PTY exit on the second (active) listener
    registeredCallbacks[1]({ exitCode: 0 });

    expect(secondCallback).toHaveBeenCalledWith(0);
    // First callback should NOT have been called (its listener was disposed)
    expect(firstCallback).not.toHaveBeenCalled();
  });
});
