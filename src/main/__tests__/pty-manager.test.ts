import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtyManager } from '../pty-manager';

// Mock node-pty since we can't spawn real PTYs in unit tests
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
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
      shell: '/bin/zsh',
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

  it('throws when creating a duplicate paneId', () => {
    manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' });
    expect(() =>
      manager.create({ paneId: 'pane-1', cwd: '/tmp', shell: '/bin/zsh' })
    ).toThrow('pane-1 already exists');
  });
});
