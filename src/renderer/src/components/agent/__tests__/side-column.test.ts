import { describe, expect, it } from 'vitest';
import { READING_COLUMN_MAX_PX, SIDE_COLUMN_WIDTH_PX, centeringGutterPx } from '../side-column';

/** A pane with room for a column on both sides of a full-width conversation. */
const WIDE = READING_COLUMN_MAX_PX + SIDE_COLUMN_WIDTH_PX * 2;

describe('centeringGutterPx', () => {
  it('is nothing when no column is up', () => {
    expect(centeringGutterPx(WIDE, false)).toBe(0);
  });

  it('is nothing before the pane has been measured', () => {
    expect(centeringGutterPx(null, true)).toBe(0);
  });

  it('matches the column once the pane can afford both', () => {
    expect(centeringGutterPx(WIDE, true)).toBe(SIDE_COLUMN_WIDTH_PX);
    expect(centeringGutterPx(WIDE + 400, true)).toBe(SIDE_COLUMN_WIDTH_PX);
  });

  it('centres the conversation on the pane at that width', () => {
    const gutter = centeringGutterPx(WIDE, true);
    // What the flex row leaves the conversation, and where `mx-auto` puts it.
    const thread = WIDE - SIDE_COLUMN_WIDTH_PX;
    const content = Math.min(thread - gutter, READING_COLUMN_MAX_PX);
    const left = gutter + (thread - gutter - content) / 2;
    expect(left + content / 2).toBe(WIDE / 2);
  });

  it('gives away only the room the conversation is not reading in', () => {
    // 100px short of symmetric: the gutter takes what is spare and no more, so
    // the conversation still reads at its full width.
    const width = WIDE - 100;
    expect(centeringGutterPx(width, true)).toBe(SIDE_COLUMN_WIDTH_PX - 100);
    expect(width - SIDE_COLUMN_WIDTH_PX - centeringGutterPx(width, true)).toBe(
      READING_COLUMN_MAX_PX
    );
  });

  it('is nothing at all in a pane the conversation already fills', () => {
    expect(centeringGutterPx(READING_COLUMN_MAX_PX + SIDE_COLUMN_WIDTH_PX, true)).toBe(0);
    expect(centeringGutterPx(600, true)).toBe(0);
  });
});
