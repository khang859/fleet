import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_TELEPROMPTER_HOTKEYS } from '../../../shared/teleprompter';
import { HotkeyRegistry, type ShortcutPort } from '../hotkeys';

function fakePort(behaviour: Record<string, 'ok' | 'taken' | 'throw'> = {}): ShortcutPort & {
  callbacks: Map<string, () => void>;
  unregister: ReturnType<typeof vi.fn>;
} {
  const callbacks = new Map<string, () => void>();
  return {
    callbacks,
    register: (accelerator, callback) => {
      const outcome = behaviour[accelerator] ?? 'ok';
      if (outcome === 'throw') throw new TypeError('conversion failure');
      if (outcome === 'taken') return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister: vi.fn((accelerator: string) => callbacks.delete(accelerator))
  };
}

describe('HotkeyRegistry', () => {
  it('registers every hotkey and routes each to its action', () => {
    const port = fakePort();
    const onAction = vi.fn();
    const statuses = new HotkeyRegistry(port).sync(DEFAULT_TELEPROMPTER_HOTKEYS, onAction);
    expect(statuses.every((s) => s.ok)).toBe(true);
    port.callbacks.get(DEFAULT_TELEPROMPTER_HOTKEYS.next)?.();
    expect(onAction).toHaveBeenCalledWith('next');
  });

  it('reports a key another app holds, and an unparseable one, without throwing', () => {
    const port = fakePort({
      [DEFAULT_TELEPROMPTER_HOTKEYS.next]: 'taken',
      [DEFAULT_TELEPROMPTER_HOTKEYS.prev]: 'throw'
    });
    const statuses = new HotkeyRegistry(port).sync(DEFAULT_TELEPROMPTER_HOTKEYS, vi.fn());
    expect(statuses.find((s) => s.action === 'next')).toMatchObject({
      ok: false,
      reason: 'in-use'
    });
    expect(statuses.find((s) => s.action === 'prev')).toMatchObject({
      ok: false,
      reason: 'invalid'
    });
    expect(statuses.find((s) => s.action === 'toggleLock')?.ok).toBe(true);
  });

  it('blames the desktop portal, not another app, for a refusal on Wayland', () => {
    const port = fakePort({ [DEFAULT_TELEPROMPTER_HOTKEYS.next]: 'taken' });
    const statuses = new HotkeyRegistry(port, 'portal').sync(DEFAULT_TELEPROMPTER_HOTKEYS, vi.fn());
    expect(statuses.find((s) => s.action === 'next')?.reason).toBe('portal');
  });

  it('refuses a key already given to another action', () => {
    const statuses = new HotkeyRegistry(fakePort()).sync(
      { ...DEFAULT_TELEPROMPTER_HOTKEYS, resetTimer: DEFAULT_TELEPROMPTER_HOTKEYS.next },
      vi.fn()
    );
    expect(statuses.find((s) => s.action === 'resetTimer')).toMatchObject({
      ok: false,
      reason: 'duplicate'
    });
  });

  it('skips hotkeys that are turned off', () => {
    const statuses = new HotkeyRegistry(fakePort()).sync(
      { ...DEFAULT_TELEPROMPTER_HOTKEYS, resetTimer: '' },
      vi.fn()
    );
    expect(statuses.map((s) => s.action)).not.toContain('resetTimer');
  });

  it('releases only the keys it registered, on re-sync and on clear', () => {
    const port = fakePort({ [DEFAULT_TELEPROMPTER_HOTKEYS.next]: 'taken' });
    const registry = new HotkeyRegistry(port);
    registry.sync(DEFAULT_TELEPROMPTER_HOTKEYS, vi.fn());
    registry.sync(DEFAULT_TELEPROMPTER_HOTKEYS, vi.fn());
    // Four registered the first time; `next` was never ours to release.
    expect(port.unregister).toHaveBeenCalledTimes(4);
    expect(port.unregister).not.toHaveBeenCalledWith(DEFAULT_TELEPROMPTER_HOTKEYS.next);
    registry.clear();
    registry.clear();
    expect(port.unregister).toHaveBeenCalledTimes(8);
  });
});
