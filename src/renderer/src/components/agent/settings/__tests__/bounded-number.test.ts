import { describe, expect, it } from 'vitest';
import { commitNumber, commitPrice, shownNumber } from '../bounded-number';

/*
 * The bug this rule exists to prevent, stated as a test.
 *
 * The field used to clamp inside `onChange`. Selecting `256` and typing `4096`
 * turned the first `4` into `256` on that keystroke, and the rest of the digits
 * landed on the replacement - so an ordinary four-digit budget could not be
 * typed at all, and the number that got saved was one nobody asked for.
 */
describe('what the field shows while it is being typed into', () => {
  it('echoes each keystroke back unchanged, however far out of range', () => {
    const typed = ['4', '40', '409', '4096'];

    expect(typed.map((draft) => shownNumber(draft, 256))).toEqual(typed);
  });

  it('lets the field be emptied', () => {
    expect(shownNumber('', 256)).toBe('');
  });

  it('shows the stored value when nobody is editing', () => {
    expect(shownNumber(null, 256)).toBe('256');
  });
});

describe('what a finished draft means', () => {
  const bounds = { min: 256, max: 4096, fallback: 1024 };

  it('keeps a number that is already in range', () => {
    expect(commitNumber('2048', bounds)).toBe(2048);
  });

  it('pulls one below the floor up to it', () => {
    expect(commitNumber('4', bounds)).toBe(256);
  });

  it('pulls one above the ceiling down to it', () => {
    expect(commitNumber('99999', bounds)).toBe(4096);
  });

  it('rounds, because these are counts of whole things', () => {
    expect(commitNumber('2048.6', bounds)).toBe(2049);
  });

  it('ignores space around the number', () => {
    expect(commitNumber('  2048  ', bounds)).toBe(2048);
  });

  /* An empty field is "whichever", not zero. Zero would be clamped to the
   * floor, which is a number the person never typed and cannot see coming. */
  it('reads an empty field as the default', () => {
    expect(commitNumber('', bounds)).toBe(1024);
    expect(commitNumber('   ', bounds)).toBe(1024);
  });

  it('reads something that is not a number as the default', () => {
    expect(commitNumber('lots', bounds)).toBe(1024);
  });
});

/*
 * The price ceiling is dollars per million tokens, so the useful values are
 * fractions of one - and typing one goes through a state that reads as zero.
 * Committing on each keystroke turned `0.5` into `5`: ten times the intended
 * rate, from a field that looked like it worked.
 */
describe('what a finished price draft means', () => {
  it('keeps a fraction of a dollar', () => {
    expect(commitPrice('0.5')).toBe(0.5);
  });

  it('survives the half-typed state that reads as zero', () => {
    expect(shownNumber('0.', 1)).toBe('0.');
  });

  it('reads an empty field as no ceiling', () => {
    expect(commitPrice('')).toBeNull();
    expect(commitPrice('  ')).toBeNull();
  });

  it('reads a negative or unreadable price as no ceiling', () => {
    expect(commitPrice('-1')).toBeNull();
    expect(commitPrice('cheap')).toBeNull();
  });

  /* Not rounded, unlike the counts: these are fractions on purpose. */
  it('does not round', () => {
    expect(commitPrice('0.125')).toBe(0.125);
  });
});
