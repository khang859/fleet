import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencySnapshot } from '../../../../../shared/agency';
import type {
  AgencyCrewMember,
  AgencyServer,
  AgencyJobDetail,
  AgencyPlanVersion,
  AgencyStep
} from '../../../../../shared/agency-jobs';
import { NO_PLAN_CHECKS } from '../../../../../shared/agency-jobs';
import { PlanSchema } from '../../../../../shared/agency-plan';
import { agencyJob } from '../../../../../shared/__tests__/agency-fixtures';
import { waitingCount } from '../../../store/agency-store';
import { CrewSwapForm } from '../CrewSwap';
import { JobSheet } from '../JobSheet';
import { PlanCard } from '../PlanCard';
import { proposedPlanId } from '../job-view';
import { NO_JOB_SPEND } from '../../../../../shared/agency-spend';

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
    checks: { envFiles: [], issues: [], overlap: [], bases: [] },
    bases: null,
    decisionNote: null,
    proposedAt: 1,
    decidedAt: null,
    diff: [],
    effects: null,
    uses: [],
    autoStartUsd: null,
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

function detail(
  versions: AgencyPlanVersion[],
  steps: AgencyStep[] = [],
  crew: AgencyCrewMember[] = [],
  servers: AgencyServer[] = []
): AgencyJobDetail {
  const approved = versions.find((v) => v.status === 'approved');
  return {
    job: agencyJob({ id: 2, approvedVersion: approved?.version ?? null }),
    versions,
    steps,
    events: [],
    log: [],
    results: [],
    spend: { ...NO_JOB_SPEND, usd: 2.5, budgetUsd: 10 },
    merge: null,
    crew,
    servers,
    permissions: []
  };
}

const card = (v: AgencyPlanVersion, d = detail([v])): string =>
  renderToStaticMarkup(createElement(PlanCard, { version: v, detail: d }));

describe('PlanCard', () => {
  it('shows a new role with its runtime, description and instructions, saved only on approval', () => {
    const html = card(
      version({
        plan: PlanSchema.parse({
          ...PLAN,
          steps: [...PLAN.steps, { id: 'migrate', role: 'data-migrator', title: 'Migrate' }],
          newRoles: [
            {
              name: 'data-migrator',
              description: 'Writes database migrations.',
              model: 'sonnet',
              instructions: 'Run each migration up and down.'
            }
          ]
        })
      })
    );
    expect(html).toContain('>NEW ROLE<');
    expect(html).toContain('data-migrator');
    expect(html).toContain(' · Claude Code · sonnet');
    expect(html).toContain('Writes database migrations.');
    expect(html).toContain('Run each migration up and down.');
    expect(html).toContain('The repository gets no file.');
    expect(card(version())).not.toContain('NEW ROLE');
  });

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
          envFiles: [],
          issues: [
            {
              code: 'pr-unavailable',
              severity: 'block',
              text: 'builder-1 delivers a PR, but fleet has no GitHub remote.',
              fix: 'use-branch'
            }
          ],
          overlap: [],
          bases: []
        }
      })
    );
    expect(html).toContain('fleet has no GitHub remote.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve plan<\/button>/);
    expect(html).toContain('Deliver local branches instead');
  });

  it('offers the Claude Code trust step without holding Approve', () => {
    const html = card(
      version({
        checks: {
          envFiles: [],
          issues: [
            {
              code: 'claude-trust',
              severity: 'warn',
              text: 'Claude Code has not run in /dev/fleet yet.',
              fix: 'trust-claude',
              path: '/dev/fleet'
            }
          ],
          overlap: [],
          bases: []
        }
      })
    );
    expect(html).toContain('Open Claude Code there');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve plan<\/button>/);
  });

  it('lists the env files each step gets, and nothing when no step gets one', () => {
    const files = [{ stepId: 'builder-1', files: ['api/.env', '.env'] }];
    const html = card(version({ checks: { ...NO_PLAN_CHECKS, envFiles: files } }));
    expect(html).toContain('ENV FILES');
    expect(html).toContain('>api/.env · .env<');
    expect(card(version())).not.toContain('ENV FILES');
  });

  it('offers where the work starts when the default tip and HEAD differ', () => {
    const base = {
      member: 'fleet',
      defaultBranch: 'main',
      defaultSha: 'a1b2c3d4e5'.padEnd(40, '0'),
      headBranch: 'feat/x',
      headSha: 'f6e5d4c3b2'.padEnd(40, '0'),
      pinned: null
    };
    const html = card(
      version({ checks: { envFiles: [], issues: [], overlap: [], bases: [base] } })
    );
    expect(html).toContain('STARTS FROM');
    expect(html).toContain('aria-label="Where fleet starts"');
    expect(html).toContain('main a1b2c3d');
    expect(html).toContain('feat/x f6e5d4c');

    const same = card(
      version({
        checks: {
          envFiles: [],
          issues: [],
          overlap: [],
          bases: [{ ...base, headSha: base.defaultSha }]
        }
      })
    );
    expect(same).toContain('main a1b2c3d');
    expect(same).not.toContain('role="radiogroup"');

    const pinned = card(
      version({
        checks: {
          envFiles: [],
          issues: [],
          overlap: [],
          bases: [{ ...base, pinned: { sha: base.headSha, from: 'head' } }]
        }
      })
    );
    expect(pinned).not.toContain('STARTS FROM');
  });

  it('lists the paths another running job touches', () => {
    const html = card(
      version({
        checks: {
          envFiles: [],
          issues: [{ code: 'overlap', severity: 'warn', text: 'j3 is also working on 1 path.' }],
          overlap: [{ jobId: 3, member: 'fleet', path: 'src/Sidebar.tsx', step: 'builder-1' }],
          bases: []
        }
      })
    );
    expect(html).toContain('j3 is also working on 1 path.');
    expect(html).toContain('j3 · fleet/src/Sidebar.tsx');
    expect(html).not.toContain('Deliver local branches instead');
  });

  it('folds a version that is no longer waiting to one line', () => {
    const replaced = version({ status: 'replaced' });
    const newer = version({ id: 8, version: 2 });
    expect(card(replaced, detail([replaced, newer]))).toContain('Plan v1 was replaced by v2');
    const rejected = version({ status: 'rejected', decisionNote: 'Too big' });
    expect(card(rejected)).toContain('You rejected Plan v1: Too big');
    const approved = version({
      status: 'approved',
      bases: { fleet: { sha: 'a1b2c3d4e5'.padEnd(40, '0'), from: 'default' } }
    });
    expect(card(approved)).toContain('Plan v1 approved · 2 steps, $10 · from a1b2c3d');
    expect(card(approved)).not.toContain('Approve plan');
    const one = version({ status: 'approved', plan: { ...PLAN, steps: PLAN.steps.slice(0, 1) } });
    expect(card(one)).toContain('Plan v1 approved · 1 step, $10');
  });

  it('lists the saved lines a plan follows as chips, and nothing when it cites none', () => {
    const uses = [
      { id: 'Y1', layer: 'you' as const, text: 'Never push to main.' },
      { id: 'P2', layer: 'project' as const, text: 'Open PRs as drafts.' }
    ];
    const html = card(version({ uses }));
    expect(html).toContain('>USING WHAT I KNOW ABOUT YOU<');
    expect(html).toContain('title="You · every project: Never push to main."');
    expect(html).toContain('title="This project: Open PRs as drafts."');
    expect(card(version())).not.toContain('USING WHAT I KNOW ABOUT YOU');
  });

  it('keeps a plan that started on its own open, with Stop and Change instead of Approve', () => {
    const started = version({ status: 'approved', autoStartUsd: 10 });
    const html = card(started);
    expect(html).toContain('Started on its own · within $10');
    expect(html).toContain('>Stop<');
    expect(html).toContain('Change something');
    expect(html).not.toContain('Approve plan');
    expect(html).not.toContain('Reject');
  });

  it('folds a plan that started on its own once it is replaced or the job ends', () => {
    const started = version({ status: 'approved', autoStartUsd: 10 });
    const newer = version({ id: 8, version: 2, kind: 'change' });
    expect(card(started, detail([started, newer]))).not.toContain('>Stop<');
    const closed = { ...detail([started]), job: agencyJob({ id: 2, state: 'closed' }) };
    expect(card(started, closed)).toContain('Plan v1 approved');
    expect(card(started, closed)).not.toContain('>Stop<');
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
    onboarding: { setupDoneAt: 1, starterDoneAt: 1, meetDue: false, meetLeft: [] },
    leftovers: [],
    clientFileChanged: false,
    trust: { level: 'ask', autoStartUsd: null },
    pastJobs: [],
    settingsCards: []
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
    expect(html).not.toContain('USING WHAT I KNOW ABOUT YOU');
    expect(html).toContain('1 of 2 steps done');
    expect(html).toContain('Build the toggle');
    expect(html).toContain('>done<');
    expect(html).toContain('>running<');
    expect(html).toContain('Reading the diff');
    expect(html).toContain('$2.50 of $10.00');
    expect(html).toContain('Nothing needs you right now.');
  });

  it('says when the approved plan started on its own, with the lines it follows', () => {
    const started = version({
      status: 'approved',
      autoStartUsd: 10,
      uses: [{ id: 'P1', layer: 'project', text: 'Open PRs as drafts.' }]
    });
    const html = sheet(snap(false), detail([started]));
    expect(html).toContain('v1 started on its own');
    expect(html).toMatch(/USING WHAT I KNOW ABOUT YOU.*Open PRs as drafts\./s);
  });

  it('says a small first plan starts on its own under a trust level that allows it', () => {
    const job = { ...detail([]), job: agencyJob({ id: 2, approvedVersion: null }) };
    expect(sheet(snap(false), job)).toContain('Nothing starts until you approve it.');
    const pr = { ...snap(false), trust: { level: 'pr' as const, autoStartUsd: null } };
    expect(sheet(pr, job)).toContain('A small first plan starts on its own.');
  });

  it('shows both meters, who spent what, the estimate marker and the overshoot', () => {
    const approved = version({ status: 'approved' });
    const d = {
      ...detail([approved]),
      spend: {
        usd: 12.5,
        weekPct: 8.5,
        budgetUsd: 10,
        budgetWeekPct: 10,
        lines: [
          { crewId: null, label: 'Admiral', usd: 0.5, weekPct: 0, estimate: false },
          { crewId: 3, label: 'builder 1', usd: 12, weekPct: 8.5, estimate: true }
        ],
        reserveUntil: new Date(2026, 9, 18, 14, 30).getTime()
      }
    };
    const html = sheet(snap(false), d);
    expect(html).toContain('$12.50 of $10.00 · 25% over');
    expect(html).toContain('~8.5% of 10%');
    expect(html).toContain('bg-red-500');
    expect(html).toContain('bg-amber-400');
    expect(html).toContain('~8.5%</span>');
    expect(html).toContain('~ is an estimate.');
    expect(html).toContain('Claude crew wait for your usage reserve until 14:30.');
  });

  it('lists the servers the crew started, with the variable each is on and its address', () => {
    const html = sheet(
      snap(false),
      detail(
        [version({ status: 'approved' })],
        [],
        [],
        [
          { stepId: 'qa', name: 'API_PORT', port: 41000, url: 'http://localhost:41000' },
          { stepId: 'qa', name: null, port: 41007, url: 'http://localhost:41007' }
        ]
      )
    );
    expect(html).toContain('SERVERS');
    expect(html).toContain('2 running');
    expect(html).toContain('API_PORT');
    expect(html).toContain('port 41007');
    expect(html).toContain('>localhost:41000<');
    expect(html).toContain('title="Open http://localhost:41007"');
  });

  it('shows no SERVERS while none listen', () => {
    expect(sheet(snap(false), detail([version({ status: 'approved' })]))).not.toContain('SERVERS');
  });

  const member = (over: Partial<AgencyCrewMember>): AgencyCrewMember => ({
    id: 1,
    stepId: 'builder-1',
    role: 'builder',
    runtime: 'claude',
    model: null,
    label: 'builder 1',
    paneId: 'pane-1',
    status: 'live',
    startedAt: 1,
    endedAt: null,
    endReason: null,
    flag: null,
    flagUntil: null,
    ...over
  });

  it('lists the crew, working ones first, with Peek only on a working member', () => {
    const html = sheet(
      snap(false),
      detail(
        [version({ status: 'approved' })],
        [step('builder-1', 'failed'), step('reviewer', 'running')],
        [
          member({ status: 'ended', endReason: 'ended with exit code 1' }),
          member({ id: 2, stepId: 'reviewer', label: 'reviewer 1', model: 'opus', paneId: 'p2' })
        ]
      )
    );
    expect(html).toContain('CREW');
    expect(html).toContain('1 working');
    expect(html.indexOf('reviewer 1')).toBeLessThan(html.indexOf('builder 1'));
    expect(html).toContain('· reviewer · Claude Code opus');
    expect(html).toContain('>working<');
    expect(html).toContain('title="ended with exit code 1"');
    expect(html.match(/>Peek</g)).toHaveLength(1);
    expect(html).toContain('>failed<');
  });

  it('offers Swap only on a working member of a step in the approved plan', () => {
    const html = sheet(
      snap(false),
      detail(
        [version({ status: 'approved' })],
        [step('reviewer', 'running')],
        [
          member({ status: 'ended' }),
          member({ id: 2, stepId: 'reviewer', label: 'reviewer 1', paneId: 'p2' }),
          member({ id: 3, stepId: 'gone', label: 'qa 1', paneId: 'p3' })
        ]
      )
    );
    expect(html.match(/>Swap</g)).toHaveLength(1);
    expect(html).toContain('title="Move its step to another role, runtime or model"');
  });

  it('starts the swap form at what the approved step runs', () => {
    const html = renderToStaticMarkup(
      createElement(CrewSwapForm, {
        repoId: 'repo-1',
        jobId: 2,
        step: PLAN.steps[1],
        onClose: () => {}
      })
    );
    expect(html).toContain('aria-label="Swap reviewer"');
    expect(html).toMatch(/<option value="reviewer" selected="">reviewer<\/option>/);
    expect(html).toMatch(/<option value="claude" selected="">Claude Code<\/option>/);
    expect(html).toContain('<option value="eva">eva</option>');
    expect(html).toContain('placeholder="The role&#x27;s own"');
    expect(html).toContain(
      'This makes a plan change. The member keeps working until you approve it.'
    );
    expect(html).toContain('>Propose swap<');
  });

  it('shows each flag in place of the status, with Hand back or Resume where the client can act', () => {
    const until = new Date(2026, 0, 1, 15, 0).getTime();
    const html = sheet(
      snap(false),
      detail(
        [version({ status: 'approved' })],
        [],
        [
          member({ id: 1, label: 'builder 1', flag: 'user-driven' }),
          member({ id: 2, label: 'builder 2', flag: 'limited', flagUntil: until }),
          member({ id: 3, label: 'builder 3', flag: 'stuck' }),
          member({ id: 4, label: 'builder 4', status: 'starting', flag: 'needs-you' })
        ]
      )
    );
    expect(html).toContain('>yours<');
    expect(html).toContain('>limited until 15:00<');
    expect(html).toContain('>stuck<');
    expect(html).toContain('>needs you<');
    expect(html).not.toContain('>working<');
    expect(html.match(/>Hand back</g)).toHaveLength(1);
    expect(html.match(/>Resume</g)).toHaveLength(1);
    expect(html).toContain('bg-red-400');
  });

  it('puts a member that needs the client under WAITING ON YOU, and counts it', () => {
    const html = sheet(
      snap(false),
      detail(
        [version({ status: 'approved' })],
        [],
        [member({ status: 'starting', flag: 'needs-you' })]
      )
    );
    expect(html).toContain('WAITING ON YOU · 1');
    expect(html).toContain('aria-label="builder 1 needs you"');
    expect(html).toContain('builder 1 needs you in its pane');
    expect(html).not.toContain('Nothing needs you right now.');
    expect(
      waitingCount({ ...snap(false), jobs: [agencyJob({ id: 2, crewNeedingYou: 1 })] }, 2)
    ).toBe(1);
    // A permission card waits on the client too.
    expect(
      waitingCount({ ...snap(false), jobs: [agencyJob({ id: 2, permissionsWaiting: [4, 5] })] }, 2)
    ).toBe(2);
  });

  it('has no CREW section before anyone is hired', () => {
    expect(sheet(snap(false), detail([version({ status: 'approved' })]))).not.toContain('CREW');
  });
});

describe('proposedPlanId', () => {
  it('reads the version id off a job_plan row', () => {
    expect(proposedPlanId({ summary: 'proposed plan v2 plan#14' })).toBe(14);
    expect(proposedPlanId({ summary: 'plan refused' })).toBeNull();
  });
});
