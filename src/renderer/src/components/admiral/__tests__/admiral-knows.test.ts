import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClientEntry } from '../../../../../shared/agency-client-file';
import { PreferenceLines, type LineDraft } from '../../settings/AdmiralKnows';

/** What the Admiral knows: each line with where it came from, one edit at a time. */

const ENTRIES: ClientEntry[] = [
  { text: 'Never push to main.', source: 'you', date: '2026-10-18' },
  { text: 'Conventional commits with a scope.', source: 'your commits', date: '2026-10-18' },
  { text: 'Typed by hand.', source: null, date: null },
  { text: 'Open PRs as drafts.', source: 'job j21', date: '2026-10-18' }
];

const lines = (entries: ClientEntry[], draft: LineDraft | null = null, disabled = false): string =>
  renderToStaticMarkup(
    createElement(PreferenceLines, {
      entries,
      draft,
      disabled,
      onDraft: () => {},
      onSave: () => {},
      onRemove: () => {}
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
