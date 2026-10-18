import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyQuestion, AgencySnapshot } from '../../../../../shared/agency';
import { agencyJob, agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { JobSheet } from '../JobSheet';
import { QuestionCard } from '../QuestionCard';

/** Client file cards, the outside-change notice, and past jobs to export. */

const REPO = '0123456789abcdef';

const proposal = (over: Partial<AgencyQuestion> = {}): AgencyQuestion =>
  agencyQuestion({
    repoId: REPO,
    kind: 'client_file',
    question: 'Change the client file?',
    context: 'You asked for drafts and said to keep doing it.',
    options: [{ label: 'Change it' }, { label: 'Not now' }],
    proposal: {
      add: [
        { text: 'Open PRs as drafts.', replaces: 'Open PRs ready for review.' },
        { text: 'Use pnpm.', replaces: null }
      ],
      remove: ['Notify me for everything.']
    },
    ...over
  });

const card = (q: AgencyQuestion, clientFileChanged = false): string =>
  renderToStaticMarkup(
    createElement(QuestionCard, {
      question: q,
      onAnswer: async () => Promise.resolve(true),
      onOpenSettings: () => {},
      clientFileChanged
    })
  );

const snap = (over: Partial<AgencySnapshot> = {}): AgencySnapshot => ({
  repoId: REPO,
  lobbySessionId: 'lobby',
  jobs: [],
  questions: [],
  nextRetryAt: null,
  onboarding: { setupDoneAt: 1, starterDoneAt: 1 },
  leftovers: [],
  clientFileChanged: false,
  pastJobs: [],
  settingsCards: [],
  ...over
});

const sheet = (snapshot: AgencySnapshot, jobId: number | null = null): string =>
  renderToStaticMarkup(
    createElement(JobSheet, {
      snapshot,
      jobId,
      detail: undefined,
      working: false,
      defaultBudgetUsd: 10,
      onAnswer: async () => Promise.resolve(true),
      onOpenSettings: () => {}
    })
  );

describe('a client file card', () => {
  it('shows the contradicted line struck out above its replacement, and the rest', () => {
    const html = card(proposal());
    const order = [
      'Change the client file?',
      'aria-label="Remove"',
      'Open PRs ready for review.',
      'aria-label="Add"',
      'Open PRs as drafts.',
      'Notify me for everything.',
      'Use pnpm.',
      `Change it<span class="whitespace-nowrap"> · My pick</span>`,
      'Not now'
    ].map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('line-through');
  });

  it('cannot be approved while the file has a change from outside Fleet', () => {
    expect(card(proposal())).not.toContain('changed outside Fleet');
    const html = card(proposal(), true);
    expect(html).toContain('The client file changed outside Fleet.');
    expect(html).toContain('Review it');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Change it<span[^>]*> · My pick<\/span><\/button>/
    );
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Not now<\/button>/);
  });

  it('says how it was answered once settled', () => {
    const html = card(proposal({ status: 'answered', answerOption: 0, answeredAt: 2 }));
    expect(html).toContain('You answered');
    expect(html).toContain('Change it');
    expect(html).toContain('Open PRs as drafts.');
  });
});

describe('the job sheet', () => {
  it('warns when the client file changed outside Fleet, and holds a waiting card', () => {
    expect(sheet(snap())).not.toContain('The client file changed outside Fleet');
    const html = sheet(snap({ clientFileChanged: true, questions: [proposal({ jobId: null })] }));
    expect(html).toContain('The client file changed outside Fleet');
    expect(html).toContain('>Review<');
    expect(html).toContain('>Keep the change<');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Change it<span[^>]*> · My pick<\/span><\/button>/
    );
  });

  it('lists past jobs to export in the lobby only', () => {
    const past = [
      agencyJob({ id: 7, title: 'Billing export', state: 'closed' }),
      agencyJob({ id: 5, title: 'Old idea', state: 'cancelled' })
    ];
    const lobby = sheet(snap({ pastJobs: past }));
    expect(lobby).toContain('PAST JOBS');
    expect(lobby).toContain('Billing export');
    expect(lobby).toContain('Cancelled');
    expect(lobby).toContain('aria-label="Export j7 as Markdown"');

    const running = agencyJob({ id: 9, state: 'running' });
    expect(sheet(snap({ pastJobs: past, jobs: [running] }), 9)).not.toContain('PAST JOBS');
    expect(sheet(snap())).not.toContain('PAST JOBS');
  });
});
