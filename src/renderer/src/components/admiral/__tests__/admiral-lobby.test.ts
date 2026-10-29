import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencySnapshot } from '../../../../../shared/agency';
import { agencyJob } from '../../../../../shared/__tests__/agency-fixtures';
import { bridgeQueue } from './queue-fixtures';
import { JobSheet } from '../JobSheet';

/** The outside-change notice, and past jobs to export. */

const REPO = '0123456789abcdef';

const snap = (over: Partial<AgencySnapshot> = {}): AgencySnapshot => ({
  repoId: REPO,
  lobbySessionId: 'lobby',
  jobs: [],
  questions: [],
  nextRetryAt: null,
  onboarding: { setupDoneAt: 1, starterDoneAt: 1, meetDue: false, meetLeft: [] },
  leftovers: [],
  clientFileChanged: false,
  pastJobs: [],
  settingsCards: [],
  decisions: [],
  held: [],
  ...over
});

/** The column beside the conversation: the Bridge queue in the lobby, else the job's sheet. */
const sheet = (snapshot: AgencySnapshot, jobId: number | null = null): string =>
  jobId === null
    ? bridgeQueue(snapshot)
    : renderToStaticMarkup(
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

describe('the job sheet', () => {
  it('warns when the client file changed outside Fleet', () => {
    expect(sheet(snap())).not.toContain('The client file changed outside Fleet');
    const html = sheet(snap({ clientFileChanged: true }));
    expect(html).toContain('The client file changed outside Fleet');
    expect(html).toContain('>Review<');
    expect(html).toContain('>Keep the change<');
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
