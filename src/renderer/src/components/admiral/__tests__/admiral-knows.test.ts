import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  normText,
  type ClientEntry,
  type PreferenceConflict
} from '../../../../../shared/agency-client-file';
import { PreferenceLines, type LineDraft } from '../../settings/AdmiralKnows';

/** What the Admiral knows: each line with where it came from, one edit at a time. */

const ENTRIES: ClientEntry[] = [
  { text: 'Never push to main.', source: 'you', date: '2026-10-18' },
  { text: 'Conventional commits with a scope.', source: 'your commits', date: '2026-10-18' },
  { text: 'Typed by hand.', source: null, date: null },
  { text: 'Open PRs as drafts.', source: 'job j21', date: '2026-10-18' }
];

const lines = (
  entries: ClientEntry[],
  draft: LineDraft | null = null,
  disabled = false,
  uses: Record<string, number> = {},
  conflicts: PreferenceConflict[] = []
): string =>
  renderToStaticMarkup(
    createElement(PreferenceLines, {
      entries,
      uses,
      conflicts,
      draft,
      disabled,
      onDraft: () => {},
      onSave: () => {},
      onRemove: () => {},
      onSettle: () => {}
    })
  );

describe('PreferenceLines', () => {
  it('shows each line with its source label, and buttons to edit or remove it', () => {
    const html = lines(ENTRIES);
    const order = [
      'Never push to main.',
      'You told me',
      'Conventional commits with a scope.',
      'Read from your commits',
      'Typed by hand.',
      'You told me',
      'Open PRs as drafts.',
      'Learned on j21'
    ];
    let at = 0;
    for (const text of order) {
      const next = html.indexOf(text, at);
      expect(next, text).toBeGreaterThanOrEqual(at);
      at = next + text.length;
    }
    expect(html).toContain('aria-label="Edit &quot;Never push to main.&quot;"');
    expect(html).toContain('aria-label="Remove &quot;Open PRs as drafts.&quot;"');
  });

  it('turns the edited line into a field and holds the other buttons', () => {
    const html = lines(ENTRIES, { index: 1, text: 'Conventional commits.' });
    expect(html).toContain('aria-label="Edit line"');
    expect(html).toContain('value="Conventional commits."');
    expect(html).not.toContain('Read from your commits');
    expect(
      html.match(/<button[^>]*aria-label="(Edit|Remove) &quot;[^>]*disabled=""/g)
    ).toHaveLength(6);
  });

  it('puts a new line at the end, and says what to do on an empty layer', () => {
    expect(lines(ENTRIES, { index: null, text: '' })).toMatch(
      /Learned on j21.*aria-label="New line"/s
    );
    expect(lines([])).toContain('Nothing yet. Add a line');
    expect(lines([], { index: null, text: 'Use pnpm.' })).toContain('value="Use pnpm."');
  });
});

describe('use counts', () => {
  it('says how many jobs used each line, and nothing for a line no job used', () => {
    const html = lines(ENTRIES, null, false, {
      [normText('Never push to main.')]: 6,
      [normText('Open PRs as drafts.')]: 1
    });
    expect(html).toMatch(/Never push to main\..*used 6 times/s);
    expect(html).toMatch(/Open PRs as drafts\..*used 1 time</s);
    expect(html.match(/used \d+ time/g)).toHaveLength(2);
  });
});

describe('conflicts', () => {
  const conflict = (status: PreferenceConflict['status']): PreferenceConflict => ({
    id: 1,
    layer: 'repo',
    normText: normText('Open PRs as drafts.'),
    ruleSource: 'CLAUDE.md',
    ruleText: 'Open PRs ready for review.',
    status
  });

  it('asks which one wins while a line clashes with a rule', () => {
    const html = lines(ENTRIES, null, false, {}, [conflict('open')]);
    expect(html).toContain('Clashes with CLAUDE.md: “Open PRs ready for review.” Which one wins?');
    expect(html).toContain('Keep this line');
    expect(html).toContain('CLAUDE.md wins');
    expect(html).not.toContain('aria-label="Remove &quot;Open PRs as drafts.&quot;"');
  });

  it('says a line that won wins over the rule, with its buttons back', () => {
    const html = lines(ENTRIES, null, false, {}, [conflict('line')]);
    expect(html).toMatch(/Open PRs as drafts\..*Wins over CLAUDE\.md/s);
    expect(html).not.toContain('Which one wins?');
    expect(html).toContain('aria-label="Remove &quot;Open PRs as drafts.&quot;"');
  });
});
