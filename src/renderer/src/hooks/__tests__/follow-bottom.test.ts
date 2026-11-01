import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { followBottom } from '../use-terminal';

/**
 * A pinned pane calls this on every write, and term.scrollToBottom() redraws
 * every row even when it moves nothing. So it must run only when the view is
 * off the bottom, and it must run for any gap, even a gap of one row.
 */

function fakeTerm(viewportY: number, baseY: number): Terminal {
  const term = { buffer: { active: { viewportY, baseY } }, scrollToBottom: vi.fn() };

  return term as unknown as Terminal;
}

describe('followBottom', () => {
  it('does nothing when the view is at the bottom', () => {
    const term = fakeTerm(120, 120);

    followBottom(term);

    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('does nothing in the alternate screen, which has no scrollback', () => {
    const term = fakeTerm(0, 0);

    followBottom(term);

    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('scrolls when the view is one row short of the bottom', () => {
    const term = fakeTerm(119, 120);

    followBottom(term);

    expect(term.scrollToBottom).toHaveBeenCalledOnce();
  });

  it('scrolls when the view was reset to the top', () => {
    const term = fakeTerm(0, 120);

    followBottom(term);

    expect(term.scrollToBottom).toHaveBeenCalledOnce();
  });
});
