import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtyManager } from '../pty-manager';

// Track mock instances so we can inspect calls on each PTY
const mockInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const instance = {
      pid: 10000 + mockInstances.length,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    };
    mockInstances.push(instance);
    return instance;
  })
}));

describe('PtyManager — extended', () => {
  let manager: PtyManager;

  beforeEach(() => {
    mockInstances.length = 0;
    manager = new PtyManager();
  });

  it('forwards write() to the underlying PTY process', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    manager.write('p1', 'ls -la\n');
    expect(mockInstances[0].write).toHaveBeenCalledWith('ls -la\n');
  });

  it('write() on non-existent pane is a no-op', () => {
    // Should not throw
    manager.write('ghost', 'hello');
  });

  it('forwards resize() to the underlying PTY process', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    manager.resize('p1', 120, 40);
    expect(mockInstances[0].resize).toHaveBeenCalledWith(120, 40);
  });

  it('resize() on non-existent pane is a no-op', () => {
    manager.resize('ghost', 80, 24);
  });

  it('killAll() kills every active PTY and empties the map', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    manager.create({ paneId: 'p2', cwd: '/tmp', shell: '/bin/sh' });
    manager.create({ paneId: 'p3', cwd: '/tmp', shell: '/bin/sh' });
    expect(manager.paneIds()).toHaveLength(3);

    manager.killAll();

    expect(manager.paneIds()).toHaveLength(0);
    expect(mockInstances[0].kill).toHaveBeenCalled();
    expect(mockInstances[1].kill).toHaveBeenCalled();
    expect(mockInstances[2].kill).toHaveBeenCalled();
  });

  it('registers an internal buffering listener on the underlying PTY at create time', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    // The internal data listener is registered immediately at create() so its
    // IDisposable can be tracked and disposed on kill(). manager.onData() stores
    // the user callback for flushing — it does NOT re-register on the PTY.
    expect(mockInstances[0].onData).toHaveBeenCalledTimes(1);
    const cb = vi.fn();
    manager.onData('p1', cb);
    // Still only one registration (at create time)
    expect(mockInstances[0].onData).toHaveBeenCalledTimes(1);
  });

  it('onData() on non-existent pane does not throw', () => {
    manager.onData('ghost', vi.fn());
  });

  it('registers onExit callback that cleans up the pane', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    const exitCb = vi.fn();
    manager.onExit('p1', exitCb);

    // The mock's onExit was called with a wrapper; simulate the PTY exiting
    const registeredHandler = mockInstances[0].onExit.mock.calls[0][0] as (e: {
      exitCode: number;
    }) => void;
    registeredHandler({ exitCode: 0 });

    expect(exitCb).toHaveBeenCalledWith(0);
    expect(manager.has('p1')).toBe(false); // auto-removed on exit
  });

  it('onExit callback receives non-zero exit codes', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    const exitCb = vi.fn();
    manager.onExit('p1', exitCb);

    const registeredHandler = mockInstances[0].onExit.mock.calls[0][0] as (e: {
      exitCode: number;
    }) => void;
    registeredHandler({ exitCode: 137 });

    expect(exitCb).toHaveBeenCalledWith(137);
  });

  it('get() returns entry for existing pane and undefined for missing', () => {
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/sh' });
    expect(manager.get('p1')).toBeDefined();
    expect(manager.get('ghost')).toBeUndefined();
  });

  it('kill() on non-existent pane is a no-op', () => {
    manager.kill('ghost'); // should not throw
  });

  it('uses provided cols and rows when creating PTY', async () => {
    const pty = await import('node-pty');
    manager.create({ paneId: 'p1', cwd: '/home', shell: '/bin/bash', cols: 200, rows: 50 });
    expect(pty.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      [],
      expect.objectContaining({ cols: 200, rows: 50, cwd: '/home' })
    );
  });

  it('passes -c flag when cmd option is provided', async () => {
    const pty = await import('node-pty');
    manager.create({ paneId: 'p1', cwd: '/tmp', shell: '/bin/zsh', cmd: 'echo hello' });
    expect(pty.spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-c', 'echo hello; exec /bin/zsh'],
      expect.objectContaining({ cwd: '/tmp' })
    );
  });
});
