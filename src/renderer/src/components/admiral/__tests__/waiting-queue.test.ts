import { describe, expect, it } from 'vitest';
import type { AgencyJob, AgencySnapshot } from '../../../../../shared/agency';
import type {
  AgencyCrewMember,
  AgencyJobDetail,
  AgencyPlanVersion
} from '../../../../../shared/agency-jobs';
import { NO_PLAN_CHECKS } from '../../../../../shared/agency-jobs';
import type { AgencyPermission } from '../../../../../shared/agency-permissions';
import type { SettingsCard } from '../../../../../shared/agency-settings';
import { PlanSchema } from '../../../../../shared/agency-plan';
import { NO_JOB_SPEND } from '../../../../../shared/agency-spend';
import { agencyJob, agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { waitingCount } from '../../../store/agency-store';
import { itemsOf, queueOrder, waitingItems, type WaitingItem } from '../waiting-queue';

/** What waits on the client, of each kind, as the Bridge queue and a job sheet read it. */

const PLAN = PlanSchema.parse({
  playbook: 'feature',
  summary: 'Add dark mode.',
  steps: [{ id: 'builder-1', role: 'builder', title: 'Build it' }],
  budget: { usd: 10 }
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
    checks: NO_PLAN_CHECKS,
    bases: null,
    decisionNote: null,
    proposedAt: 30,
    decidedAt: null,
    diff: [],
    previous: null,
    effects: null,
    uses: [],
    autoStartUsd: null,
    ...over
  };
}

function permission(over: Partial<AgencyPermission> = {}): AgencyPermission {
  return {
    id: 5,
    jobId: 2,
    crewId: 9,
    crewLabel: 'builder 1',
    stepId: 'builder-1',
    tool: 'Bash',
    target: 'npm publish',
    state: 'client',
    answeredBy: null,
    reason: 'It publishes.',
    summary: null,
    recommend: null,
    createdAt: 10,
    askedAt: 12,
    expiresAt: 500,
    answeredAt: null,
    ...over
  };
}

function crew(over: Partial<AgencyCrewMember> = {}): AgencyCrewMember {
  return {
    id: 9,
    stepId: 'builder-1',
    role: 'builder',
    runtime: 'claude',
    model: null,
    label: 'builder 1',
    paneId: 'pane-9',
    status: 'live',
    flag: 'needs-you',
    flagUntil: null,
    startedAt: 20,
    endedAt: null,
    endReason: null,
    ...over
  };
}

function settings(over: Partial<SettingsCard> = {}): SettingsCard {
  return {
    id: 4,
    repoId: 'repo-1',
    jobId: null,
    at: 40,
    reason: 'You asked for it.',
    changes: [
      {
        id: 1,
        key: 'agency.trust',
        label: 'Trust',
        before: 'ask',
        after: 'auto',
        kind: 'approve',
        status: 'pending'
      }
    ],
    ...over
  };
}

function job(over: Partial<AgencyJob> = {}): AgencyJob {
  return agencyJob({ id: 2, state: 'planned', updatedAt: 50, ...over });
}

function detail(of: AgencyJob, over: Partial<AgencyJobDetail> = {}): AgencyJobDetail {
  return {
    job: of,
    versions: [],
    steps: [],
    events: [],
    log: [],
    results: [],
    spend: NO_JOB_SPEND,
    merge: null,
    crew: [],
    servers: [],
    permissions: [],
    ...over
  };
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

/** A job with one of everything waiting, and the lobby with a question and a settings card. */
function busy(): { snapshot: AgencySnapshot; details: Record<number, AgencyJobDetail> } {
  const waiting = job({
    pendingPlan: { id: 7, version: 1 },
    permissionsWaiting: [5, 8],
    crewNeedingYou: 1
  });
  const done = job({ id: 3, state: 'delivered', updatedAt: 60 });
  const snapshot = snap({
    jobs: [waiting, done],
    questions: [
      agencyQuestion({ id: 35, jobId: 2, createdAt: 25 }),
      agencyQuestion({ id: 36, jobId: null, createdAt: 15 }),
      agencyQuestion({ id: 37, jobId: 2, status: 'answered' })
    ],
    settingsCards: [settings(), settings({ id: 6, jobId: 2, at: 45 })]
  });
  const details = {
    2: detail(waiting, {
      versions: [version({ id: 6, status: 'replaced' }), version({ version: 2 })],
      permissions: [
        permission(),
        permission({ id: 8, state: 'in_pane', askedAt: null, expiresAt: null }),
        permission({ id: 3, state: 'allowed' })
      ],
      crew: [crew(), crew({ id: 10, flag: null })]
    }),
    3: detail(done)
  };
  return { snapshot, details };
}

const keys = (items: WaitingItem[]): string[] => items.map((i) => i.key);

describe('waitingItems', () => {
  it('lists each kind once, in the order a job sheet shows them', () => {
    const { snapshot, details } = busy();
    expect(keys(waitingItems(snapshot, details, 2))).toEqual([
      'perm:5',
      'perm:8',
      'plan:7',
      'q:35',
      'settings:6',
      'crew:9'
    ]);
    expect(keys(waitingItems(snapshot, details, 3))).toEqual(['delivered:3']);
    expect(keys(waitingItems(snapshot, details, null))).toEqual(['q:36', 'settings:4']);
  });

  it('takes every open job and the lobby for the whole project', () => {
    const { snapshot, details } = busy();
    expect(keys(waitingItems(snapshot, details))).toEqual([
      'perm:5',
      'perm:8',
      'plan:7',
      'q:35',
      'settings:6',
      'crew:9',
      'delivered:3',
      'q:36',
      'settings:4'
    ]);
    expect(waitingItems(undefined, details)).toEqual([]);
  });

  it('dates a permission from when the client was asked, and lets only a client card expire', () => {
    const { snapshot, details } = busy();
    const [card, inPane] = itemsOf(waitingItems(snapshot, details, 2), 'permission');
    expect(card).toMatchObject({ since: 12, expiresAt: 500, permission: { id: 5 } });
    expect(inPane).toMatchObject({ since: 10, expiresAt: null });
  });

  it('stands a loading row in for what the snapshot says waits, under the same key', () => {
    const { snapshot, details } = busy();
    const loading = waitingItems(snapshot, {}, 2);
    expect(keys(loading)).toEqual([
      'perm:5',
      'perm:8',
      'plan:7',
      'q:35',
      'settings:6',
      'crew:job2-0'
    ]);
    expect(itemsOf(loading, 'loading').map((i) => i.what)).toEqual([
      'permission',
      'permission',
      'plan',
      'crew'
    ]);
    expect(itemsOf(waitingItems(snapshot, {}, 3), 'delivered')[0].detail).toBeUndefined();
    expect(waitingItems(snapshot, details, 3)).toHaveLength(1);
  });

  it('leaves out what the client decided and Fleet still holds', () => {
    const { snapshot, details } = busy();
    const held = snap({
      ...snapshot,
      held: [
        { id: 1, jobId: 2, key: 'plan:7', label: 'Approved plan v1', runsAt: 99 },
        { id: 2, jobId: null, key: 'q:36', label: 'Answered q36', runsAt: 99 }
      ]
    });
    const left = keys(waitingItems(held, details));
    expect(left).not.toContain('plan:7');
    expect(left).not.toContain('q:36');
    expect(keys(waitingItems(held, {}, 2))).not.toContain('plan:7');
  });
});

describe('queueOrder', () => {
  it('puts what expires first, soonest first, then the rest oldest first', () => {
    const { snapshot, details } = busy();
    const items = waitingItems(snapshot, details);
    const soon = { ...items[0], key: 'soon', expiresAt: 100 };
    expect(keys(queueOrder([...items, soon]))).toEqual([
      'soon',
      'perm:5',
      'perm:8',
      'q:36',
      'crew:9',
      'q:35',
      'plan:7',
      'settings:4',
      'settings:6',
      'delivered:3'
    ]);
  });
});

describe('waitingCount', () => {
  it('counts the queue, the same before and after the details load', () => {
    const { snapshot, details } = busy();
    expect(waitingCount(snapshot)).toBe(waitingItems(snapshot, details).length);
    expect(waitingCount(snapshot, 2)).toBe(waitingItems(snapshot, details, 2).length);
    expect(waitingCount(snapshot, null)).toBe(2);
    expect(waitingCount(undefined)).toBe(0);
  });
});
