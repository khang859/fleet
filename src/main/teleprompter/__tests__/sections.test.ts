import { describe, it, expect } from 'vitest';
import { splitSections } from '../sections';

describe('splitSections', () => {
  it('splits on lines of ---', () => {
    expect(splitSections('Intro\n---\nSlide two\n---\nOutro')).toEqual([
      'Intro',
      'Slide two',
      'Outro'
    ]);
  });

  it('returns nothing for empty or blank notes', () => {
    expect(splitSections('')).toEqual([]);
    expect(splitSections('  \n\n---\n  ')).toEqual([]);
  });

  it('drops empty sections from repeated or trailing separators', () => {
    expect(splitSections('A\n---\n---\n\n---\nB\n---\n')).toEqual(['A', 'B']);
  });

  it('keeps --- inside a backtick fence as content', () => {
    const notes = 'Before\n```yaml\n---\nkey: 1\n```\n---\nAfter';
    expect(splitSections(notes)).toEqual(['Before\n```yaml\n---\nkey: 1\n```', 'After']);
  });

  it('keeps --- inside a tilde fence, which only a tilde fence closes', () => {
    const notes = '~~~\n```\n---\n~~~\n---\nNext';
    expect(splitSections(notes)).toEqual(['~~~\n```\n---\n~~~', 'Next']);
  });

  it('needs a closing fence at least as long as the opening one', () => {
    const notes = '````\n```\n---\n````\n---\nNext';
    expect(splitSections(notes)).toHaveLength(2);
  });

  it('skips YAML front matter', () => {
    expect(splitSections('---\ntitle: Talk\n---\nFirst\n---\nSecond')).toEqual(['First', 'Second']);
  });

  it('treats a leading --- before plain text as a separator, not front matter', () => {
    expect(splitSections('---\nIntro\n---\nSecond')).toEqual(['Intro', 'Second']);
  });

  it('ignores unclosed front matter', () => {
    expect(splitSections('---\ntitle: Talk\nFirst')).toEqual(['title: Talk\nFirst']);
  });

  it('handles CRLF line endings and a BOM', () => {
    expect(splitSections('﻿One\r\n---\r\nTwo')).toEqual(['One', 'Two']);
  });

  it('does not split on longer rules or --- with text', () => {
    expect(splitSections('A\n----\nB\n--- not a rule\nC')).toHaveLength(1);
  });

  it('allows up to three spaces of indent and trailing spaces', () => {
    expect(splitSections('A\n   ---  \nB')).toEqual(['A', 'B']);
  });
});
