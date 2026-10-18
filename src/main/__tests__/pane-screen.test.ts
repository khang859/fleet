import { describe, expect, it } from 'vitest';
import { PaneScreen } from '../pane-screen';

describe('PaneScreen', () => {
  it('reads what a full-screen program shows now, not the output that led to it', async () => {
    const screen = new PaneScreen(40, 5);
    screen.write('$ claude\r\nloading...');
    // Clear the screen and draw a trust prompt in place, as a TUI does.
    screen.write('\x1b[2J\x1b[H Do you trust this folder?\r\n\x1b[32m> 1. Yes\x1b[0m\r\n  2. No');
    expect(await screen.text()).toBe(' Do you trust this folder?\n> 1. Yes\n  2. No');
    screen.dispose();
  });

  it('keeps only the screen once output scrolls, and follows a resize', async () => {
    const screen = new PaneScreen(20, 2);
    screen.write('one\r\ntwo\r\nthree');
    expect(await screen.text()).toBe('two\nthree');
    screen.resize(20, 3);
    screen.write('\r\nfour');
    expect((await screen.text()).split('\n').at(-1)).toBe('four');
    screen.dispose();
  });
});
