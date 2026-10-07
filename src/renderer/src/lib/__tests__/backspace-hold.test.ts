import { describe, expect, it } from 'vitest';
import {
  HOLD_WORDS_AFTER_MS,
  createBackspaceHold,
  isLinuxCtrlBackspace,
  type HoldKey
} from '../backspace-hold';

function key(overrides: Partial<HoldKey> = {}): HoldKey {
  return {
    type: 'keydown',
    key: 'Backspace',
    repeat: false,
    timeStamp: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides
  };
}

/** A press at 0, then OS repeats every 30ms up to `until`. */
function hold(until: number): boolean[] {
  const heldLong = createBackspaceHold();
  const steps = [heldLong(key())];
  for (let t = 500; t <= until; t += 30) {
    steps.push(heldLong(key({ repeat: true, timeStamp: t })));
  }
  return steps;
}

describe('createBackspaceHold', () => {
  it('deletes characters for the first second of a hold', () => {
    expect(hold(HOLD_WORDS_AFTER_MS - 1)).not.toContain(true);
  });

  it('switches to words once the key has been held long enough', () => {
    const steps = hold(HOLD_WORDS_AFTER_MS + 200);
    expect(steps.at(-1)).toBe(true);
    expect(steps.indexOf(true)).toBeGreaterThan(10);
  });

  it('switches exactly at the threshold', () => {
    const heldLong = createBackspaceHold();
    heldLong(key());
    expect(heldLong(key({ repeat: true, timeStamp: HOLD_WORDS_AFTER_MS - 1 }))).toBe(false);
    expect(heldLong(key({ repeat: true, timeStamp: HOLD_WORDS_AFTER_MS }))).toBe(true);
  });

  it('starts over on a fresh press', () => {
    const heldLong = createBackspaceHold();
    heldLong(key());
    heldLong(key({ repeat: true, timeStamp: HOLD_WORDS_AFTER_MS + 10 }));
    expect(heldLong(key({ timeStamp: HOLD_WORDS_AFTER_MS + 50 }))).toBe(false);
    expect(heldLong(key({ repeat: true, timeStamp: HOLD_WORDS_AFTER_MS + 80 }))).toBe(false);
  });

  it('starts the clock at a repeat when focus arrived mid-hold', () => {
    const heldLong = createBackspaceHold();
    expect(heldLong(key({ repeat: true, timeStamp: 5000 }))).toBe(false);
    expect(heldLong(key({ repeat: true, timeStamp: 5030 }))).toBe(false);
    expect(heldLong(key({ repeat: true, timeStamp: 5000 + HOLD_WORDS_AFTER_MS }))).toBe(true);
  });

  it.each([
    ['a keyup', { type: 'keyup' }],
    ['another key', { key: 'a' }],
    ['an IME composition', { isComposing: true }],
    ['Alt', { altKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }]
  ])('ends a hold already deleting words on %s', (_, interruption) => {
    const heldLong = createBackspaceHold();
    heldLong(key());
    expect(heldLong(key({ repeat: true, timeStamp: HOLD_WORDS_AFTER_MS }))).toBe(true);
    expect(heldLong(key({ repeat: true, timeStamp: 1030, ...interruption }))).toBe(false);
    // The repeats that follow are a new hold, not a continuation of the old one.
    expect(heldLong(key({ repeat: true, timeStamp: 1060 }))).toBe(false);
  });
});

describe('isLinuxCtrlBackspace', () => {
  it('matches Ctrl+Backspace on Linux only', () => {
    const ctrl = key({ ctrlKey: true });
    expect(isLinuxCtrlBackspace(ctrl, 'linux')).toBe(true);
    expect(isLinuxCtrlBackspace(ctrl, 'win32')).toBe(false);
    expect(isLinuxCtrlBackspace(ctrl, 'darwin')).toBe(false);
  });

  it.each([
    ['a bare Backspace', {}],
    ['Ctrl+Shift+Backspace', { ctrlKey: true, shiftKey: true }],
    ['Ctrl+Alt+Backspace', { ctrlKey: true, altKey: true }],
    ['a Ctrl+Backspace keyup', { ctrlKey: true, type: 'keyup' }],
    ['Ctrl+Delete', { ctrlKey: true, key: 'Delete' }],
    ['an IME composition', { ctrlKey: true, isComposing: true }]
  ])('leaves %s to xterm', (_, overrides) => {
    expect(isLinuxCtrlBackspace(key(overrides), 'linux')).toBe(false);
  });
});
