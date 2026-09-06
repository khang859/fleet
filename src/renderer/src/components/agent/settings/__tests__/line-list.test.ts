import { describe, expect, it } from 'vitest';
import { commitLines, shownLines } from '../line-list';

/*
 * The bug this rule exists to prevent, stated as a test.
 *
 * The textarea used to normalise inside `onChange`. Typing `first.example` and
 * pressing Enter produced `first.example\n`, which was filtered straight back
 * to one entry and rendered without the newline - so the next host landed on
 * the end of the first one and the list could never hold two. Pasting a whole
 * list happened to work, which is what hid it.
 */
describe('what the field shows while it is being typed into', () => {
  it('keeps the newline that starts the next entry', () => {
    expect(shownLines('first.example\n', ['first.example'])).toBe('first.example\n');
  });

  it('keeps a blank line in the middle, which is a person mid-edit', () => {
    expect(shownLines('a.test\n\nb.test', ['a.test', 'b.test'])).toBe('a.test\n\nb.test');
  });

  it('shows the stored list when nobody is editing', () => {
    expect(shownLines(null, ['a.test', 'b.test'])).toBe('a.test\nb.test');
  });

  it('shows nothing for an empty stored list', () => {
    expect(shownLines(null, [])).toBe('');
  });
});

describe('what a finished draft means', () => {
  it('reads one entry per line', () => {
    expect(commitLines('a.test\nb.test')).toEqual(['a.test', 'b.test']);
  });

  /* A trailing newline is where the person stopped, not a rule that matches
   * nothing. */
  it('drops the blank lines', () => {
    expect(commitLines('a.test\n\nb.test\n')).toEqual(['a.test', 'b.test']);
  });

  it('trims each entry, because a pasted host arrives with space around it', () => {
    expect(commitLines('  a.test  \n\tb.test')).toEqual(['a.test', 'b.test']);
  });

  it('reads an empty field as an empty list', () => {
    expect(commitLines('')).toEqual([]);
    expect(commitLines('\n \n')).toEqual([]);
  });
});
