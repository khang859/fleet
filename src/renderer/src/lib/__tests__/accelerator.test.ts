import { describe, it, expect } from 'vitest';
import { formatAccelerator, keyEventToAccelerator } from '../accelerator';

function press(
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
  key = code
) {
  return { code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe('keyEventToAccelerator', () => {
  it('builds an accelerator in Electron modifier order', () => {
    expect(keyEventToAccelerator(press('PageDown', { ctrlKey: true, altKey: true }), 'linux')).toBe(
      'Control+Alt+PageDown'
    );
  });

  it('reads the physical key, not the character Alt or Shift produced', () => {
    expect(
      keyEventToAccelerator(press('KeyP', { altKey: true, ctrlKey: true }, 'π'), 'darwin')
    ).toBe('Control+Alt+P');
    expect(
      keyEventToAccelerator(press('Digit0', { ctrlKey: true, shiftKey: true }, ')'), 'win32')
    ).toBe('Control+Shift+0');
  });

  it('names the meta key per platform', () => {
    expect(keyEventToAccelerator(press('KeyK', { metaKey: true }), 'darwin')).toBe('Command+K');
    expect(keyEventToAccelerator(press('KeyK', { metaKey: true }), 'linux')).toBe('Super+K');
  });

  it('waits while only modifiers are held', () => {
    expect(
      keyEventToAccelerator(press('ControlLeft', { ctrlKey: true }, 'Control'), 'linux')
    ).toBeNull();
  });

  it('refuses a key without Control, Alt or Command', () => {
    expect(keyEventToAccelerator(press('KeyA'), 'linux')).toBeNull();
    expect(keyEventToAccelerator(press('KeyA', { shiftKey: true }), 'linux')).toBeNull();
  });

  it('refuses keys Electron cannot bind', () => {
    expect(keyEventToAccelerator(press('IntlBackslash', { ctrlKey: true }), 'linux')).toBeNull();
  });
});

describe('formatAccelerator', () => {
  it('uses symbols on macOS', () => {
    expect(formatAccelerator('Control+Alt+PageDown', 'darwin')).toBe('⌃⌥PgDn');
    expect(formatAccelerator('Command+Shift+Left', 'darwin')).toBe('⌘⇧←');
  });

  it('uses words elsewhere', () => {
    expect(formatAccelerator('Control+Alt+PageUp', 'win32')).toBe('Ctrl+Alt+PgUp');
  });
});
