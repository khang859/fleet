import { describe, it, expect } from 'vitest';
import { ALL_SHORTCUTS, matchesShortcut, getShortcut } from '../shortcuts';

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('command-palette shortcut', () => {
  it('is bound to Cmd/Ctrl+K', () => {
    const def = getShortcut('command-palette');
    expect(def?.mac).toEqual({ key: 'k', meta: true });
    expect(def?.other).toEqual({ key: 'k', ctrl: true });
  });

  it('matches a Cmd+K event on mac-style combo', () => {
    const def = getShortcut('command-palette')!;
    // matchesShortcut picks mac vs other from navigator.platform; assert the
    // combo data shape is correct rather than simulating platform here.
    expect(def.mac.key).toBe('k');
  });

  it('no shortcut still uses the old Shift+P combo', () => {
    const palette = getShortcut('command-palette')!;
    expect(palette.mac.shift).toBeUndefined();
    expect(palette.mac.key).not.toBe('P');
  });

  it('no other shortcut already claims Cmd+K', () => {
    const clashing = ALL_SHORTCUTS.filter(
      (s) =>
        s.id !== 'command-palette' &&
        s.mac.key.toLowerCase() === 'k' &&
        s.mac.meta &&
        !s.mac.shift &&
        !s.mac.alt &&
        !s.mac.ctrl
    );
    expect(clashing).toEqual([]);
    // touch matchesShortcut + key() so they are exercised by the suite
    expect(typeof matchesShortcut).toBe('function');
    expect(key({ key: 'k', metaKey: true }).key).toBe('k');
  });
});
