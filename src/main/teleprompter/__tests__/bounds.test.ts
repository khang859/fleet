import { describe, it, expect } from 'vitest';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  clampRect,
  defaultRect,
  resolveInitialBounds,
  type DisplayArea
} from '../bounds';

const PRIMARY: DisplayArea = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
/** A second display to the left of the primary, so its coordinates are negative. */
const LEFT: DisplayArea = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };

describe('defaultRect', () => {
  it('sits centred at the top, under a laptop camera', () => {
    expect(defaultRect(PRIMARY.workArea)).toEqual({ x: 400, y: 49, width: 640, height: 200 });
  });

  it('fits a work area narrower than the default', () => {
    expect(defaultRect({ x: 0, y: 0, width: 500, height: 150 }).width).toBe(500);
  });
});

describe('clampRect', () => {
  it('pulls a window hanging off the right edge back on, using its own width', () => {
    const rect = clampRect({ x: 1300, y: 100, width: 600, height: 200 }, PRIMARY.workArea);
    expect(rect.x).toBe(1440 - 600);
  });

  it('shrinks a window larger than the display', () => {
    const rect = clampRect({ x: 0, y: 0, width: 3000, height: 2000 }, PRIMARY.workArea);
    expect(rect).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  it('never goes below the minimum size', () => {
    const rect = clampRect({ x: 10, y: 30, width: 10, height: 10 }, PRIMARY.workArea);
    expect(rect.width).toBe(MIN_WINDOW_WIDTH);
    expect(rect.height).toBe(MIN_WINDOW_HEIGHT);
  });

  it('works on a display with negative coordinates', () => {
    const rect = clampRect({ x: -5000, y: 50, width: 600, height: 200 }, LEFT.workArea);
    expect(rect.x).toBe(-1920);
  });
});

describe('resolveInitialBounds', () => {
  const rectOnLeft = { x: -1000, y: 100, width: 500, height: 180 };

  it('reopens where it was left, on the display it was last on', () => {
    const saved = { lastDisplayId: 2, byDisplay: { '2': rectOnLeft } };
    expect(resolveInitialBounds(saved, [PRIMARY, LEFT], 1)).toEqual(rectOnLeft);
  });

  it('falls back to the primary display when the last one is disconnected', () => {
    const saved = { lastDisplayId: 2, byDisplay: { '2': rectOnLeft } };
    expect(resolveInitialBounds(saved, [PRIMARY], 1)).toEqual(defaultRect(PRIMARY.workArea));
  });

  it('uses the spot saved for the primary display when falling back to it', () => {
    const onPrimary = { x: 100, y: 500, width: 400, height: 150 };
    const saved = { lastDisplayId: 2, byDisplay: { '1': onPrimary, '2': rectOnLeft } };
    expect(resolveInitialBounds(saved, [PRIMARY], 1)).toEqual(onPrimary);
  });

  it('uses the default position the first time', () => {
    expect(
      resolveInitialBounds({ lastDisplayId: null, byDisplay: {} }, [PRIMARY, LEFT], 1)
    ).toEqual(defaultRect(PRIMARY.workArea));
  });
});
