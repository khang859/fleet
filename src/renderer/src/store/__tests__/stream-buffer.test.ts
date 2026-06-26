import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamBuffer } from '../stream-buffer';

describe('StreamBuffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid deltas into a single flush per window', () => {
    const flushed: string[] = [];
    const buf = new StreamBuffer(50, (d) => flushed.push(d));
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(flushed).toEqual([]); // nothing flushed synchronously
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(['abc']);
  });

  it('emits a second window after more deltas arrive', () => {
    const flushed: string[] = [];
    const buf = new StreamBuffer(50, (d) => flushed.push(d));
    buf.push('a');
    vi.advanceTimersByTime(50);
    buf.push('b');
    buf.push('c');
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(['a', 'bc']);
  });

  it('ignores empty deltas', () => {
    const flushed: string[] = [];
    const buf = new StreamBuffer(50, (d) => flushed.push(d));
    buf.push('');
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual([]);
  });

  it('flush() emits buffered text immediately and cancels the timer', () => {
    const flushed: string[] = [];
    const buf = new StreamBuffer(50, (d) => flushed.push(d));
    buf.push('x');
    buf.flush();
    expect(flushed).toEqual(['x']);
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(['x']); // no duplicate trailing flush
  });

  it('reset() drops buffered text without emitting', () => {
    const flushed: string[] = [];
    const buf = new StreamBuffer(50, (d) => flushed.push(d));
    buf.push('lost');
    buf.reset();
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual([]);
  });
});
