import { describe, it, expect } from 'vitest';
import { SeqTracker } from '../seq-tracker';

describe('SeqTracker', () => {
  it('accepts the first report from a source when seq is undefined', () => {
    const t = new SeqTracker();
    expect(t.accept('p1', 'fleet:claude', undefined)).toBe(true);
  });

  it('rejects subsequent undefined-seq reports from the same source', () => {
    const t = new SeqTracker();
    t.accept('p1', 'fleet:claude', undefined);
    expect(t.accept('p1', 'fleet:claude', undefined)).toBe(false);
  });

  it('accepts a strictly increasing seq', () => {
    const t = new SeqTracker();
    expect(t.accept('p1', 'fleet:claude', 100n)).toBe(true);
    expect(t.accept('p1', 'fleet:claude', 101n)).toBe(true);
  });

  it('rejects a stale seq (equal or lower)', () => {
    const t = new SeqTracker();
    t.accept('p1', 'fleet:claude', 100n);
    expect(t.accept('p1', 'fleet:claude', 100n)).toBe(false);
    expect(t.accept('p1', 'fleet:claude', 99n)).toBe(false);
  });

  it('isolates sequences per source', () => {
    const t = new SeqTracker();
    t.accept('p1', 'fleet:claude', 100n);
    expect(t.accept('p1', 'fleet:codex', 1n)).toBe(true);
  });

  it('isolates sequences per pane', () => {
    const t = new SeqTracker();
    t.accept('p1', 'fleet:claude', 100n);
    expect(t.accept('p2', 'fleet:claude', 1n)).toBe(true);
  });

  it('reset clears all sources for a pane', () => {
    const t = new SeqTracker();
    t.accept('p1', 'fleet:claude', 100n);
    t.accept('p1', 'fleet:codex', 50n);
    t.reset('p1');
    expect(t.accept('p1', 'fleet:claude', 1n)).toBe(true);
    expect(t.accept('p1', 'fleet:codex', 1n)).toBe(true);
  });

  it('reset does not clear other panes', () => {
    const t = new SeqTracker();
    t.accept('p1', 'fleet:claude', 100n);
    t.accept('p2', 'fleet:claude', 100n);
    t.reset('p1');
    expect(t.accept('p2', 'fleet:claude', 100n)).toBe(false);
  });
});
