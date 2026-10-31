import { describe, expect, it } from 'vitest';
import { isPersonInput } from '../person-input';

describe('isPersonInput', () => {
  it.each([
    ['a letter', 'a'],
    ['enter', '\r'],
    ['ctrl-c', '\x03'],
    ['an arrow key', '\x1b[A'],
    ['a kitty key', '\x1b[97u'],
    ['a paste', 'some text\r']
  ])('takes %s as a person', (_name, data) => {
    expect(isPersonInput(data)).toBe(true);
  });

  it.each([
    ['a device reply', '\x1b[?1;2c'],
    ['a second device reply', '\x1b[>0;276;0c'],
    ['a cursor report', '\x1b[12;40R'],
    ['a status report', '\x1b[0n'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['a keyboard mode reply', '\x1b[?0u'],
    ['a mouse move', '\x1b[<35;10;4M'],
    ['a color reply', '\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['a version reply', '\x1bP>|xterm.js\x1b\\'],
    ['two replies at once', '\x1b[I\x1b[?1;2c']
  ])('does not take %s as a person', (_name, data) => {
    expect(isPersonInput(data)).toBe(false);
  });
});
