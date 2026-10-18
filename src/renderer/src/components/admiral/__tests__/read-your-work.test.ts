import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReadProposal, ReadSource } from '../../../../../shared/agency-understanding';
import { ReadLines, ReadSources, type LineChoice } from '../ReadYourWork';

/** Read your work: what may be read, and the lines the read proposed. */

const text = (html: string): string => html.replace(/<[^>]+>/g, '');

const SOURCES: ReadSource[] = [
  { id: 'instructions', available: true, detail: 'CLAUDE.md and your ~/.claude/CLAUDE.md' },
  { id: 'commits', available: true, detail: 'Commits by me@example.com.' },
  { id: 'reviews', available: false, detail: 'Sign in to the GitHub CLI to read this.' },
  { id: 'prs', available: false, detail: 'Sign in to the GitHub CLI to read this.' },
  { id: 'jobs', available: true, detail: '3 jobs.' }
];

describe('ReadSources', () => {
  const sources = (ticked: string[]): string =>
    renderToStaticMarkup(
      createElement(ReadSources, {
        sources: SOURCES,
        ticked: new Set(ticked) as ReadonlySet<ReadSource['id']>,
        disabled: false,
        onToggle: () => {}
      })
    );

  it('shows each source with what it reads, ticked as the client left it', () => {
    const html = sources(['instructions', 'jobs']);
    expect(text(html)).toContain('Your last 100 commits');
    expect(text(html)).toContain('The messages only. Not the code.');
    expect(text(html)).toContain('Commits by me@example.com.');
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });

  it('holds a source that cannot be read unticked, and says why', () => {
    const html = sources(['reviews', 'prs']);
    expect(html.match(/checked=""/g)).toBeNull();
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(text(html)).toContain('Sign in to the GitHub CLI to read this.');
  });
});

const LINES: ReadProposal[] = [
  {
    text: 'Conventional commits with a scope.',
    layer: 'project',
    source: 'your commits',
    evidence: '94 of 100 commits',
    clash: null
  },
  {
    text: 'Skip docs unless asked.',
    layer: 'project',
    source: 'past jobs',
    evidence: 'j19 dropped the docs step',
    clash: { source: 'CLAUDE.md', rule: 'Update docs with every change.' }
  },
  {
    text: 'Reproduce a bug before fixing it.',
    layer: 'you',
    source: 'your CLAUDE.md',
    evidence: 'says to reproduce first',
    clash: null
  }
];

describe('ReadLines', () => {
  const read = (choices: Array<[number, LineChoice]> = []): string =>
    renderToStaticMarkup(
      createElement(ReadLines, {
        lines: LINES,
        choices: new Map(choices),
        disabled: false,
        onChoose: () => {}
      })
    );

  it('shows each line with its source, evidence and layer, and Keep or Not me', () => {
    const html = text(read());
    expect(html).toContain('From your commits: 94 of 100 commits · This project');
    expect(html).toContain('From your CLAUDE.md: says to reproduce first · You');
    expect(html.match(/Keep/g)).toHaveLength(3);
    expect(html.match(/Not me/g)).toHaveLength(3);
  });

  it('flags a line that clashes with a rule', () => {
    expect(text(read())).toContain(
      'Clashes with CLAUDE.md: “Update docs with every change.” If you keep it, you pick which one wins.'
    );
  });

  it('marks a kept line, and strikes a dropped one with Undo', () => {
    const html = read([
      [0, 'kept'],
      [1, 'dropped']
    ]);
    expect(text(html)).toMatch(/Conventional commits with a scope\..*Kept/s);
    expect(html).toMatch(/line-through[^>]*>Skip docs unless asked\./);
    expect(text(html)).toContain('Dropped · not saved');
    expect(text(html)).toContain('Undo');
    expect(text(html)).not.toContain('Update docs with every change.');
    expect(text(html).match(/Not me/g)).toHaveLength(1);
  });
});
