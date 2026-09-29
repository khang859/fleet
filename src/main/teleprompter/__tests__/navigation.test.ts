import { describe, it, expect } from 'vitest';
import { clampIndex, previewLine, step, toView } from '../navigation';

describe('step', () => {
  it('moves and stops at both ends', () => {
    expect(step({ index: 0, timerStartedAt: 1 }, 1, 3, 5).index).toBe(1);
    expect(step({ index: 2, timerStartedAt: 1 }, 1, 3, 5).index).toBe(2);
    expect(step({ index: 0, timerStartedAt: 1 }, -1, 3, 5).index).toBe(0);
  });

  it('starts the timer on the first press and never restarts it', () => {
    const first = step({ index: 0, timerStartedAt: null }, 1, 3, 100);
    expect(first.timerStartedAt).toBe(100);
    expect(step(first, 1, 3, 200).timerStartedAt).toBe(100);
  });

  it('starts the timer even when the press cannot move', () => {
    expect(step({ index: 0, timerStartedAt: null }, -1, 1, 42).timerStartedAt).toBe(42);
  });
});

describe('clampIndex', () => {
  it('pulls the index back when the notes shrink', () => {
    expect(clampIndex(7, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(4, 0)).toBe(0);
  });
});

describe('previewLine', () => {
  it.each([
    ['## Heading here', 'Heading here'],
    ['\n\n- first point\n- second', 'first point'],
    ['> quoted', 'quoted'],
    ['1. numbered', 'numbered'],
    ['plain text', 'plain text']
  ])('%j previews as %j', (section, preview) => {
    expect(previewLine(section)).toBe(preview);
  });
});

describe('toView', () => {
  it('shows the current section and a preview of the next', () => {
    expect(toView(['# One', '# Two'], 0)).toEqual({ current: '# One', nextPreview: 'Two' });
  });

  it('has no preview on the last section, and nothing at all with no notes', () => {
    expect(toView(['A', 'B'], 1).nextPreview).toBeNull();
    expect(toView([], 0)).toEqual({ current: '', nextPreview: null });
  });
});
