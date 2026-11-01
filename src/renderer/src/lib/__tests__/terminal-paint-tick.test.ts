import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPaintTick, onNextPaintTick, PAINT_TICK_MS } from '../terminal-paint-tick';

describe('terminal paint tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('runs panes that joined at different times together', () => {
    const first = vi.fn();
    const second = vi.fn();

    onNextPaintTick(first);
    vi.advanceTimersByTime(PAINT_TICK_MS - 1);
    onNextPaintTick(second);
    expect(first).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('runs a pane once when it joins twice', () => {
    const flush = vi.fn();

    onNextPaintTick(flush);
    onNextPaintTick(flush);
    vi.advanceTimersByTime(PAINT_TICK_MS);

    expect(flush).toHaveBeenCalledOnce();
  });

  it('does not run a cancelled pane', () => {
    const flush = vi.fn();

    onNextPaintTick(flush);
    cancelPaintTick(flush);
    vi.advanceTimersByTime(PAINT_TICK_MS);

    expect(flush).not.toHaveBeenCalled();
  });

  it('runs a pane on the next tick when it joins during a tick', () => {
    const later = vi.fn();
    const flush = vi.fn(() => onNextPaintTick(later));

    onNextPaintTick(flush);
    vi.advanceTimersByTime(PAINT_TICK_MS);
    expect(later).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PAINT_TICK_MS);
    expect(later).toHaveBeenCalledOnce();
  });
});
