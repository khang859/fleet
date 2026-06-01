import { describe, expect, it } from 'vitest';
import {
  RUNE_READY_MARKER,
  stripRuneReadyMarker,
  type RuneReadyMarkerState
} from '../use-terminal';

function state(): RuneReadyMarkerState {
  return { pending: '' };
}

describe('stripRuneReadyMarker', () => {
  it('strips a complete marker from one chunk', () => {
    const s = state();

    const result = stripRuneReadyMarker(s, `before${RUNE_READY_MARKER}after`);

    expect(result).toEqual({ output: 'beforeafter', readySeen: true });
    expect(s.pending).toBe('');
  });

  it('handles a marker split across chunks', () => {
    const s = state();
    const split = 8;

    const first = stripRuneReadyMarker(s, `before${RUNE_READY_MARKER.slice(0, split)}`);
    const second = stripRuneReadyMarker(s, `${RUNE_READY_MARKER.slice(split)}after`);

    expect(first).toEqual({ output: 'before', readySeen: false });
    expect(second).toEqual({ output: 'after', readySeen: true });
    expect(s.pending).toBe('');
  });

  it('strips multiple markers from one chunk', () => {
    const s = state();

    const result = stripRuneReadyMarker(s, `${RUNE_READY_MARKER}a${RUNE_READY_MARKER}b`);

    expect(result).toEqual({ output: 'ab', readySeen: true });
    expect(s.pending).toBe('');
  });

  it('preserves non-matching OSC output', () => {
    const s = state();
    const otherOsc = '\x1b]777;other\x07';

    const result = stripRuneReadyMarker(s, `before${otherOsc}after`);

    expect(result).toEqual({ output: `before${otherOsc}after`, readySeen: false });
    expect(s.pending).toBe('');
  });

  it('consumes marker-only chunks without display output', () => {
    const s = state();

    const result = stripRuneReadyMarker(s, RUNE_READY_MARKER);

    expect(result).toEqual({ output: '', readySeen: true });
    expect(s.pending).toBe('');
  });

  it('flushes pending partial marker text when requested at terminal disposal', () => {
    const s = state();
    const partial = RUNE_READY_MARKER.slice(0, 4);

    const first = stripRuneReadyMarker(s, partial);
    const flushed = stripRuneReadyMarker(s, '', true);

    expect(first).toEqual({ output: '', readySeen: false });
    expect(flushed).toEqual({ output: partial, readySeen: false });
    expect(s.pending).toBe('');
  });
});
