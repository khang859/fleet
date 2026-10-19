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
import { agencyJob } from '../../../../../shared/__tests__/agency-fixtures';

/** What waits on the client, of each kind, for the queue model and the Bridge queue tests. */

export const PLAN = PlanSchema.parse({
  playbook: 'feature',
  summary: 'Add dark mode.',
  steps: [{ id: 'builder-1', role: 'builder', title: 'Build it' }],
  budget: { usd: 10 }
});

export function version(over: Partial<AgencyPlanVersion> = {}): AgencyPlanVersion {
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

export function permission(over: Partial<AgencyPermission> = {}): AgencyPermission {
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

export function crew(over: Partial<AgencyCrewMember> = {}): AgencyCrewMember {
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

export function settings(over: Partial<SettingsCard> = {}): SettingsCard {
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

export function job(over: Partial<AgencyJob> = {}): AgencyJob {
  return agencyJob({ id: 2, state: 'planned', updatedAt: 50, ...over });
}

export function detail(of: AgencyJob, over: Partial<AgencyJobDetail> = {}): AgencyJobDetail {
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

export const snap = (over: Partial<AgencySnapshot> = {}): AgencySnapshot => ({
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
