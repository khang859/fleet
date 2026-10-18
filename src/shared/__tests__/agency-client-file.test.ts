import { describe, expect, it } from 'vitest';
import {
  clientEntryList,
  editClientLine,
  numberedEntries,
  numberedText,
  removeClientLine,
  sourceLabel,
  STARTER_SOURCE,
  YOU_SOURCE
} from '../agency-client-file';

/** The line edits the What the Admiral knows page makes, and the labels it shows. */

const FILE = [
  '# shop',
  '- Open PRs as drafts. (from starter questions, 2026-10-17)',
  'A paragraph the client wrote.',
  '- Use pnpm.',
  '- Conventional commits with a scope. (from your commits, 2026-10-18)',
  ''
].join('\n');

describe('clientEntryList', () => {
  it('lists the list lines in order, with the tag of each line Fleet wrote', () => {
    expect(clientEntryList(FILE)).toEqual([
      { text: 'Open PRs as drafts.', source: STARTER_SOURCE, date: '2026-10-17' },
      { text: 'Use pnpm.', source: null, date: null },
      { text: 'Conventional commits with a scope.', source: 'your commits', date: '2026-10-18' }
    ]);
  });
});

describe('editClientLine', () => {
  it('makes an edited Fleet line one the client told Fleet, in its place', () => {
    const text = editClientLine(
      FILE,
      {
        index: 2,
        was: 'Conventional commits with a scope.',
        text: 'Conventional commits, always scoped.'
      },
      '2026-10-19'
    );
    expect(text?.split('\n')[4]).toBe(
      '- Conventional commits, always scoped. (from you, 2026-10-19)'
    );
  });

  it('keeps an edited hand line a hand line', () => {
    const text = editClientLine(
      FILE,
      { index: 1, was: 'Use pnpm.', text: 'Use pnpm 9.' },
      '2026-10-19'
    );
    expect(text?.split('\n')[3]).toBe('- Use pnpm 9.');
  });

  it('refuses a line that changed since the client saw it', () => {
    expect(editClientLine(FILE, { index: 1, was: 'Use npm.', text: 'x' }, '2026-10-19')).toBeNull();
    expect(
      editClientLine(FILE, { index: 9, was: 'Use pnpm.', text: 'x' }, '2026-10-19')
    ).toBeNull();
  });
});

describe('removeClientLine', () => {
  it('removes only that line', () => {
    const text = removeClientLine(FILE, { index: 0, was: 'Open PRs as drafts' });
    expect(clientEntryList(text).map((e) => e.text)).toEqual([
      'Use pnpm.',
      'Conventional commits with a scope.'
    ]);
    expect(text).toContain('A paragraph the client wrote.');
  });
});

describe('numberedEntries', () => {
  it('numbers the list lines for the note', () => {
    expect(numberedEntries(FILE, 'P').map((n) => n.id)).toEqual(['P1', 'P2', 'P3']);
  });
});

describe('sourceLabel', () => {
  it('names each source the way the page shows it', () => {
    expect(sourceLabel(null)).toBe('You told me');
    expect(sourceLabel(YOU_SOURCE)).toBe('You told me');
    expect(sourceLabel(STARTER_SOURCE)).toBe('Starter questions');
    expect(sourceLabel('job j21')).toBe('Learned on j21');
    expect(sourceLabel('the Bridge')).toBe('Learned on the Bridge');
    expect(sourceLabel('CLAUDE.md')).toBe('Read from CLAUDE.md');
  });
});

describe('numberedText', () => {
  it('numbers the list lines, keeps other lines, and drops the heading', () => {
    expect(
      numberedText('# fleet\n- Use pnpm. (from you, 2026-10-18)\nSome prose.\n- Draft PRs.\n', 'P')
    ).toBe('P1. Use pnpm. (from you, 2026-10-18)\nSome prose.\nP2. Draft PRs.');
  });
});
