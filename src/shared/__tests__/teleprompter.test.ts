import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TELEPROMPTER_HOTKEYS,
  TELEPROMPTER_MAX_FONT_SIZE,
  TELEPROMPTER_MIN_OPACITY,
  clampFontSize,
  clampOpacity,
  findAcceleratorConflicts,
  formatElapsed
} from '../teleprompter';

describe('findAcceleratorConflicts', () => {
  it('finds nothing in the defaults', () => {
    expect(findAcceleratorConflicts(DEFAULT_TELEPROMPTER_HOTKEYS).size).toBe(0);
  });

  it('reports only the later of two actions sharing a key', () => {
    const conflicts = findAcceleratorConflicts({
      ...DEFAULT_TELEPROMPTER_HOTKEYS,
      resetTimer: DEFAULT_TELEPROMPTER_HOTKEYS.next
    });
    expect([...conflicts]).toEqual(['resetTimer']);
  });

  it('treats modifier order and aliases as the same key', () => {
    const conflicts = findAcceleratorConflicts({
      ...DEFAULT_TELEPROMPTER_HOTKEYS,
      next: 'Control+Alt+N',
      prev: 'Alt+Ctrl+n'
    });
    expect(conflicts.has('prev')).toBe(true);
  });

  it('ignores hotkeys that are turned off', () => {
    const conflicts = findAcceleratorConflicts({
      ...DEFAULT_TELEPROMPTER_HOTKEYS,
      next: '',
      prev: ''
    });
    expect(conflicts.size).toBe(0);
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [9_999, '0:09'],
    [59 * 60_000 + 59_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_600_000 + 5 * 60_000 + 7_000, '1:05:07'],
    [-500, '0:00']
  ])('%i ms reads as %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe('clamps', () => {
  it('keeps font size and opacity within their ranges', () => {
    expect(clampFontSize(500)).toBe(TELEPROMPTER_MAX_FONT_SIZE);
    expect(clampOpacity(0)).toBe(TELEPROMPTER_MIN_OPACITY);
    expect(clampOpacity(0.5)).toBe(0.5);
  });
});
