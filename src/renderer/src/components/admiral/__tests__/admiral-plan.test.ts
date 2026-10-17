import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencySnapshot } from '../../../../../shared/agency';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  AgencyStep
} from '../../../../../shared/agency-jobs';
import { PlanSchema } from '../../../../../shared/agency-plan';
import { agencyJob } from '../../../../../shared/__tests__/agency-fixtures';
import { waitingCount } from '../../../store/agency-store';
import { JobSheet } from '../JobSheet';
import { PlanCard } from '../PlanCard';
import { proposedPlanId } from '../job-view';

/** The plan card and the sheet's plan sections, in each state a version can be in. */

const PLAN = PlanSchema.parse({
  playbook: 'feature',
  summary: 'Add dark mode to settings.',
  steps: [
    { id: 'builder-1', role: 'builder', title: 'Build the toggle', deliverables: ['pr'] },
    {
      id: 'reviewer',
      role: 'reviewer',
      title: 'Review it',
      after: ['builder-1'],
      runtime: 'claude'
    }
  ],
  budget: { usd: 10, weekPct: 10 },
  asksFirst: ['merge']
});

function version(over: Partial<AgencyPlanVersion> = {}): AgencyPlanVersion {
  return {
    id: 7,
    jobId: 2,
    version: 1,
    status: 'proposed',
    kind: 'initial',
    author: 'admiral',
    parentVersion: null,
    plan: PLAN,
    checks: { issues: [], overlap: [] },
    bases: null,
    decisionNote: null,
    proposedAt: 1,
    decidedAt: null,
    diff: [],
    effects: null,
    ...over
  };
}

function step(id: string, status: AgencyStep['status'], note = ''): AgencyStep {
  return {
    jobId: 2,
    id,
    role: id === 'reviewer' ? 'reviewer' : 'builder',
    position: 0,
    status,
    addedIn: 1,
    removedIn: null,
    note,
    updatedAt: 1,
    finishedAt: null
  };
}

function detail(versions: AgencyPlanVersion[], steps: AgencyStep[] = []): AgencyJobDetail {
  const approved = versions.find((v) => v.status === 'approved');
  return {
    job: agencyJob({ id: 2, approvedVersion: approved?.version ?? null }),
    versions,
    steps,
    events: [],
    log: [],
    spendUsd: 2.5
  };
}

const card = (v: AgencyPlanVersion, d = detail([v])): string =>
  renderToStaticMarkup(createElement(PlanCard, { version: v, detail: d }));

describe('PlanCard', () => {
  it('puts a first plan up with its steps, deliverables, asks and budget', () => {
    const html = card(version());
    expect(html).toContain('aria-label="Plan v1"');
    expect(html).toContain('>PLAN<');
    expect(html).toContain('Add dark mode to settings.');
    expect(html).toContain('Build the toggle');
    expect(html).toContain(' · reviewer · Claude Code');
    expect(html).toContain('Branch and PR');
    expect(html).toContain('I ask you first: merge.');
    expect(html).toContain('Budget $10 and 10% of week · 2 steps');
    expect(html).toContain('Approve plan');
    expect(html).toContain('Change something');
    expect(html).not.toContain('WHAT CHANGES');
  });

  it('shows a change with what it changes, what it stops and a choice per swap', () => {
    const html = card(
      version({
        id: 8,
        version: 2,
        kind: 'change',
        parentVersion: 1,
        diff: [
          { kind: 'removed', step: 'reviewer' },
          { kind: 'changed', step: 'builder-1', fields: ['role'] }
        ],
        effects: {
          stopCrew: [{ crewId: 3, stepId: 'reviewer', label: 'Reviewer' }],
          swaps: [{ stepId: 'builder-1', fields: ['role'] }],
          withdrawnQuestions: [11],
          deliveredResults: 0,
          spendUsd: 2.5
        }
      })
    );
    expect(html).toContain('PLAN CHANGE · v2 · NEEDS YOUR OK');
    expect(html).toContain('Removes reviewer');
    expect(html).toContain('Changes builder-1: role');
    expect(html).toContain('Stops Reviewer when you approve');
    expect(html).toContain('Withdraws 1 open question');
    expect(html).toContain('$2.50 spent so far · 0 results delivered');
    expect(html).toContain('Continue its work');
    expect(html).toContain('Start over');
    expect(html).toContain('Approve change');
  });

  it('keeps Approve off while a check blocks the plan', () => {
    const html = card(
      version({
        checks: {
          issues: [{ code: 'no-remote', severity: 'block', text: 'There is no GitHub remote.' }],
          overlap: []
        }
      })
    );
    expect(html).toContain('There is no GitHub remote.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve plan<\/button>/);
  });

  it('folds a version that is no longer waiting to one line', () => {
    const replaced = version({ status: 'replaced' });
    const newer = version({ id: 8, version: 2 });
    expect(card(replaced, detail([replaced, newer]))).toContain('Plan v1 was replaced by v2');
    const rejected = version({ status: 'rejected', decisionNote: 'Too big' });
    expect(card(rejected)).toContain('You rejected Plan v1: Too big');
    const approved = version({ status: 'approved' });
    expect(card(approved)).toContain('Plan v1 approved · 2 steps, $10');
    expect(card(approved)).not.toContain('Approve plan');
  });
});

describe('the sheet', () => {
  const snap = (pending: boolean): AgencySnapshot => ({
    repoId: '0123456789abcdef',
    lobbySessionId: 'lobby',
    jobs: [
      agencyJob({ id: 2, title: 'Dark mode', pendingPlan: pending ? { id: 7, version: 1 } : null })
    ],
    questions: [],
    nextRetryAt: null,
    onboarding: { setupDoneAt: 1, starterDoneAt: 1 }
  });
  const sheet = (snapshot: AgencySnapshot, d: AgencyJobDetail): string =>
    renderToStaticMarkup(
      createElement(JobSheet, {
        snapshot,
        jobId: 2,
        detail: d,
        working: false,
        defaultBudgetUsd: 10,
        onAnswer: async () => Promise.resolve(true),
        onOpenSettings: () => {}
      })
    );

  it('puts a waiting plan under WAITING ON YOU and counts it', () => {
    const html = sheet(snap(true), detail([version()]));
    expect(html).toContain('WAITING ON YOU · 1');
    expect(html).toContain('Approve plan');
    expect(html).toContain('Nothing starts until you approve the plan above.');
    expect(waitingCount(snap(true), 2)).toBe(1);
    expect(waitingCount(snap(true), null)).toBe(0);
  });

  it('lists the approved plan step by step with progress and spend', () => {
    const approved = version({ status: 'approved' });
    const html = sheet(
      snap(false),
      detail(
        [approved],
        [step('builder-1', 'done'), step('reviewer', 'running', 'Reading the diff')]
      )
    );
    expect(html).toContain('v1 approved');
    expect(html).toContain('1 of 2 steps done');
    expect(html).toContain('Build the toggle');
    expect(html).toContain('>done<');
    expect(html).toContain('>running<');
    expect(html).toContain('Reading the diff');
    expect(html).toContain('$2.50 of $10');
    expect(html).toContain('Nothing needs you right now.');
  });
});

describe('proposedPlanId', () => {
  it('reads the version id off a job_plan row', () => {
    expect(proposedPlanId({ summary: 'proposed plan v2 plan#14' })).toBe(14);
    expect(proposedPlanId({ summary: 'plan refused' })).toBeNull();
  });
});
