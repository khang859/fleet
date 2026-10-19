import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyJob, AgencyQuestion, AgencySnapshot } from '../../../../../shared/agency';
import { agencyJob, agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { QuestionCard } from '../QuestionCard';
import { JobSheet } from '../JobSheet';
import { JobTabs } from '../JobTabs';
import { askedQuestionId, jobLink, jobStatus } from '../job-view';

/** The question card and the job sheet, in each state the client can find them in. */

function question(over: Partial<AgencyQuestion> = {}): AgencyQuestion {
  return agencyQuestion({
    question: 'Which database?',
    context: 'Both are already in the lockfile.',
    options: [{ label: 'SQLite', detail: 'one file' }, { label: 'Postgres' }],
    ...over
  });
}

function job(over: Partial<AgencyJob> = {}): AgencyJob {
  return agencyJob({
    id: 2,
    title: 'Fix the tab drag',
    brief: 'Dragging a tab onto itself loses it.',
    state: 'briefing',
    budgetUsd: 25,
    ...over
  });
}

const card = (q: AgencyQuestion): string =>
  renderToStaticMarkup(
    createElement(QuestionCard, {
      question: q,
      onAnswer: async () => Promise.resolve(true),
      onOpenSettings: () => {}
    })
  );

function sheet(
  snapshot: AgencySnapshot | undefined,
  jobId: number | null,
  working = false
): string {
  return renderToStaticMarkup(
    createElement(JobSheet, {
      snapshot,
      jobId,
      detail: undefined,
      working,
      defaultBudgetUsd: 10,
      onAnswer: async () => Promise.resolve(true),
      onOpenSettings: () => {}
    })
  );
}

const snap = (over: Partial<AgencySnapshot> = {}): AgencySnapshot => ({
  repoId: 'repo-1',
  lobbySessionId: 'lobby',
  jobs: [],
  questions: [],
  nextRetryAt: null,
  onboarding: { setupDoneAt: 1, starterDoneAt: 1, meetDue: false, meetLeft: [] },
  leftovers: [],
  clientFileChanged: false,
  trust: { level: 'ask', autoStartUsd: null },
  pastJobs: [],
  settingsCards: [],
  decisions: [],
  held: [],
  ...over
});

describe('QuestionCard', () => {
  it('puts an open question up with the Admiral’s pick marked and room for own words', () => {
    const html = card(question());
    expect(html).toContain('Which database?');
    expect(html).toContain('q4');
    expect(html).toContain('Both are already in the lockfile.');
    expect(html).toContain('SQLite<span class="whitespace-nowrap"> · My pick</span>');
    expect(html).toContain('title="one file"');
    expect(html).toContain('>Postgres<');
    expect(html).toContain('Or answer in your own words');
    expect(html).toContain('border-amber-400/35');
  });

  it('says how a settled question was answered, and when it came late', () => {
    const html = card(
      question({ status: 'answered', answerOption: 1, answerText: 'with pgvector', answeredAt: 2 })
    );
    expect(html).toContain('Postgres - with pgvector');
    expect(html).not.toContain('Or answer in your own words');
    expect(html).not.toContain('after it was withdrawn');

    const late = card(question({ status: 'answered', answerOption: 0, late: true, answeredAt: 2 }));
    expect(late).toContain('after it was withdrawn, so the Admiral was told it came late');
  });

  it('keeps a withdrawn question answerable, without the pick lit up', () => {
    const html = card(question({ status: 'withdrawn', withdrawnReason: 'the crew found out' }));
    expect(html).toContain('Withdrawn: the crew found out. You can still answer');
    expect(html).not.toContain('My pick');
    expect(html).toContain('Or answer in your own words');
  });

  it('draws nothing for a hidden question', () => {
    expect(card(question({ status: 'hidden' }))).toBe('');
  });

  it('offers Retry and Settings when the model cannot be reached', () => {
    const q = question({
      kind: 'model_unreachable',
      question: 'The Admiral cannot reach its model',
      context: '401 from OpenRouter',
      options: [{ label: 'Retry' }]
    });
    const html = card(q);
    expect(html).toContain('>Retry<');
    expect(html).toContain('>Open Settings<');
    expect(html).not.toContain('My pick');
    expect(card({ ...q, status: 'withdrawn' })).toContain('The model answered again.');
    expect(card({ ...q, status: 'answered', answerOption: 0, answeredAt: 2 })).toContain(
      'Retried.'
    );
  });
});

describe('JobSheet', () => {
  it('explains how a job goes before the first brief', () => {
    const html = sheet(snap(), null);
    expect(html).toContain('width:380px');
    expect(html).toContain('THE JOB');
    expect(html).toContain('Your job sheet shows up here once I open a job.');
    expect(html).toContain('HOW A JOB GOES');
    expect(html).toContain('Default budget');
    expect(html).toContain('$10');
    expect(html).not.toContain('>WAITING ON YOU');
    expect(html).toContain('You approve. Crew start in their own tab');
    expect(sheet(snap({ trust: { level: 'pr', autoStartUsd: null } }), null)).toContain(
      'A small plan starts on its own, a bigger one when you approve.'
    );
  });

  it('shows the job on screen with only its own questions', () => {
    const html = sheet(
      snap({
        jobs: [job()],
        questions: [question({ jobId: 2 }), question({ id: 5, jobId: 3, question: 'Elsewhere?' })]
      }),
      2
    );
    expect(html).toContain('Fix the tab drag');
    expect(html).toContain('j2');
    expect(html).toContain('Dragging a tab onto itself loses it.');
    expect(html).toContain('Waiting on you');
    expect(html).toContain('WAITING ON YOU · 1');
    expect(html).toContain('Which database?');
    expect(html).not.toContain('Elsewhere?');
    expect(html).toContain('PLAN');
    expect(html).toContain('>Budget<');
    expect(html).toContain('$25');
    expect(html).not.toContain('HOW A JOB GOES');
  });

  it('says nothing needs the client when a job has no open question', () => {
    const html = sheet(snap({ jobs: [job()] }), 2, true);
    expect(html).toContain('Nothing needs you right now.');
    expect(html).toContain('Working');
  });

  it('points at the tabs from a lobby that already has jobs', () => {
    expect(sheet(snap({ jobs: [job()] }), null)).toContain('Pick a job above');
  });

  it('asks the client to accept a delivered job, and offers Cancel on an open one', () => {
    const delivered = sheet(snap({ jobs: [job({ state: 'delivered' })] }), 2);
    expect(delivered).toContain('WAITING ON YOU · 1');
    expect(delivered).toContain('Everything in the plan is in');
    expect(delivered).toContain('Accept and close');
    expect(delivered).toContain('Cancel job');

    const closing = sheet(snap({ jobs: [job({ state: 'closing' })] }), 2);
    expect(closing).toContain('Closing');
    expect(closing).not.toContain('Cancel job');
    expect(sheet(snap(), null)).not.toContain('Cancel job');
  });

  it('lists what cleanup left behind, with Retry and Dismiss, in any view of the repository', () => {
    const leftovers = [
      {
        id: 7,
        jobId: 3,
        kind: 'member_worktree' as const,
        label: 'Designer worktree',
        path: '/Users/me/.fleet/worktrees/app/admiral-3-designer-1-1',
        status: 'kept' as const,
        detail: '3 untracked files'
      },
      {
        id: 8,
        jobId: 3,
        kind: 'crew_pane' as const,
        label: 'Builder 1 pane',
        path: 'pane-1',
        status: 'failed' as const,
        detail: 'the pane did not stop'
      }
    ];
    const html = sheet(snap({ leftovers }), null);
    expect(html).toContain('LEFTOVERS · 2');
    expect(html).toContain('Kept: 3 untracked files');
    expect(html).toContain('Not cleaned: the pane did not stop');
    expect(html).toContain('admiral-3-designer-1-1');
    expect(html).not.toContain('>pane-1<');
    expect(html.match(/>Retry</g)).toHaveLength(2);
    expect(html.match(/>Dismiss</g)).toHaveLength(2);
  });
});

describe('JobTabs', () => {
  const tabs = (snapshot: AgencySnapshot, activeJobId: number | null = null): string =>
    renderToStaticMarkup(
      createElement(JobTabs, {
        snapshot,
        activeJobId,
        working: new Set<number>(),
        onSelect: () => {}
      })
    );

  it('says no jobs yet only before the first job, and no open jobs after', () => {
    expect(tabs(snap())).toContain('No jobs yet');
    const after = tabs(snap({ pastJobs: [job({ state: 'cancelled' })] }));
    expect(after).toContain('No open jobs');
    expect(after).not.toContain('No jobs yet');
    expect(tabs(snap({ jobs: [job()] }))).toContain('role="tablist"');
  });

  it('pins the Bridge tab first, selected while the lobby is on screen, and no add button', () => {
    const html = tabs(snap({ jobs: [job()] }));
    expect(html.indexOf('Bridge')).toBeLessThan(html.indexOf(job().title));
    expect(html).toMatch(/aria-selected="true"[^>]*>Bridge</);
    expect(html).not.toContain('New brief');
  });

  it("counts on the Bridge tab what waits across the project, from a job's tab too", () => {
    const asking = snap({
      jobs: [job(), job({ id: 3, title: 'Other' })],
      questions: [question({ id: 1, jobId: 2 }), question({ id: 2, jobId: null })],
      held: [{ id: 1, jobId: 3, key: 'q:9', label: 'Answered q9', runsAt: 0 }]
    });
    const html = tabs(asking, 3);
    expect(html).toContain('aria-label="Bridge, 2 waiting on you"');
    expect(html).toMatch(/Bridge<span[^>]*>2<\/span>/);
    expect(tabs(snap({ jobs: [job()] }))).not.toContain('waiting on you');
  });
});

describe('job view helpers', () => {
  it('links a lobby line to an open job, and says how a job with no tab ended', () => {
    expect(jobLink(snap({ jobs: [job()] }), 2)).toEqual({ open: true, ended: null });
    expect(jobLink(snap({ pastJobs: [job({ state: 'cancelled' })] }), 2)).toEqual({
      open: false,
      ended: 'Cancelled'
    });
    expect(jobLink(snap(), 2)).toEqual({ open: false, ended: null });
    expect(jobLink(undefined, 2)).toEqual({ open: false, ended: null });
  });

  it('puts a question to the client ahead of everything else', () => {
    expect(jobStatus({ state: 'running' }, { asking: true, working: true })).toEqual({
      label: 'Waiting on you',
      tone: 'amber'
    });
    expect(jobStatus({ state: 'planned' }, { asking: false, working: true }).label).toBe('Working');
    expect(jobStatus({ state: 'planned' }, { asking: false, working: false })).toEqual({
      label: 'Plan ready',
      tone: 'blue'
    });
  });

  it('reads the question id an ask_client call put up', () => {
    expect(askedQuestionId({ summary: 'asked q12', result: null })).toBe(12);
    expect(askedQuestionId({ summary: null, result: 'q3 is up for the client.' })).toBe(3);
    expect(askedQuestionId({ summary: null, result: 'refused' })).toBeNull();
  });
});
