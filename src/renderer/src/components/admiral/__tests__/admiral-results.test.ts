import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyResult, PrState, ResultBody } from '../../../../../shared/agency-jobs';
import { ResultCard } from '../ResultCard';
import { deliveredResultId } from '../job-view';

/** A result card for each kind a step can hand back. */

const PR: PrState = {
  number: 12,
  url: 'https://github.com/acme/app/pull/12',
  title: 'Add dark mode',
  branch: 'admiral/3/builder-1',
  base: 'main',
  headSha: 'b'.repeat(40),
  state: 'open',
  draft: false,
  additions: 120,
  deletions: 8,
  changedFiles: 6,
  checks: { passed: 3, failed: 1, pending: 1 }
};

function result(body: ResultBody, over: Partial<AgencyResult> = {}): AgencyResult {
  return {
    id: 7,
    jobId: 3,
    stepId: 'builder-1',
    kind: body.kind,
    label: 'Branch and PR',
    listed: true,
    title: 'Add dark mode',
    body,
    changedAfterDelivery: false,
    deliveredAt: 0,
    member: null,
    merge: null,
    ...over
  };
}

const html = (r: AgencyResult): string =>
  renderToStaticMarkup(createElement(ResultCard, { result: r }));

describe('ResultCard', () => {
  it('shows a PR with its title, branch, diff stat and checks, and opens it', () => {
    const out = html(result({ kind: 'pr', pr: PR }));
    for (const text of [
      'Branch and PR',
      'Add dark mode',
      '#12',
      'admiral/3/builder-1 → main',
      '+120',
      '−8',
      '6 files',
      'Checks: 3 passed',
      ', 1 failed',
      ', 1 pending',
      'Open PR',
      'Open'
    ]) {
      expect(out).toContain(text);
    }
    expect(out).not.toContain('Changed after delivery');
  });

  it('marks a PR that changed after delivery, and a draft or merged one', () => {
    expect(html(result({ kind: 'pr', pr: PR }, { changedAfterDelivery: true }))).toContain(
      'Changed after delivery'
    );
    expect(html(result({ kind: 'pr', pr: { ...PR, draft: true } }))).toContain('Draft');
    expect(html(result({ kind: 'pr', pr: { ...PR, state: 'merged' } }))).toContain('Merged');
  });

  it('shows images as thumbnails that open in Fleet', () => {
    const out = html(
      result(
        {
          kind: 'image',
          files: [{ name: 'hero.png', path: '/r/hero.png', type: 'image/png', size: 9 }]
        },
        { label: 'Images', title: 'Hero art' }
      )
    );
    expect(out).toContain('Hero art');
    expect(out).toContain('aria-label="Open hero.png"');
    expect(out).toContain('src="fleet-image:///r/hero.png"');
  });

  it('shows a file with its name, type and size, and ways to open it', () => {
    const out = html(
      result(
        {
          kind: 'file',
          files: [
            { name: 'pricing.xlsx', path: '/r/pricing.xlsx', type: 'application/zip', size: 2048 }
          ]
        },
        { label: 'File', title: 'Pricing', listed: false }
      )
    );
    expect(out).toContain('extra');
    expect(out).toContain('pricing.xlsx');
    expect(out).toContain('application/zip · 2.0 KB');
    expect(out).not.toContain('Open in Fleet');
    expect(out).toContain('Show in Finder');
  });

  it('opens a document in Fleet', () => {
    const out = html(
      result(
        {
          kind: 'doc',
          files: [{ name: 'notes.md', path: '/r/notes.md', type: 'text/markdown', size: 4 }]
        },
        { label: 'Release notes', title: 'Notes for v2' }
      )
    );
    expect(out).toContain('Release notes');
    expect(out).toContain('Open in Fleet');
  });

  it('shows copy with a copy control, and links with their address', () => {
    const copy = html(result({ kind: 'copy', text: 'Dark mode is here.' }, { title: 'Tweet' }));
    expect(copy).toContain('Dark mode is here.');
    expect(copy).toContain('>Copy<');
    const link = html(
      result({ kind: 'preview', url: 'https://app-git-dark.vercel.app' }, { title: 'Preview' })
    );
    expect(link).toContain('https://app-git-dark.vercel.app');
    expect(link).toContain('Open in browser');
  });

  it('shows a local branch with its commit', () => {
    const out = html(result({ kind: 'branch', branch: 'feat/dark', sha: 'c'.repeat(40) }));
    expect(out).toContain('feat/dark');
    expect(out).toContain('ccccccc');
  });
});

describe('deliveredResultId', () => {
  it('reads the result off a job_deliver row', () => {
    expect(deliveredResultId({ summary: 'delivered pr result#12' })).toBe(12);
    expect(deliveredResultId({ summary: 'not delivered' })).toBeNull();
  });
});
