import type { AgencyJob, AgencyQuestion } from '../agency';

/** Agency rows for tests, as main hands them out: an open question, a running job. */

export function agencyQuestion(over: Partial<AgencyQuestion> = {}): AgencyQuestion {
  return {
    id: 4,
    repoId: '0123456789abcdef',
    jobId: null,
    planVersion: null,
    step: null,
    kind: 'ask',
    question: 'Which one?',
    context: '',
    options: [{ label: 'A' }, { label: 'B' }],
    recommended: 0,
    dependsOn: null,
    status: 'open',
    answerOption: null,
    answerText: null,
    proposal: null,
    late: false,
    withdrawnReason: null,
    createdAt: 1,
    answeredAt: null,
    ...over
  };
}

export function agencyJob(over: Partial<AgencyJob> = {}): AgencyJob {
  return {
    id: 1,
    repoId: '0123456789abcdef',
    title: 'Job',
    brief: '',
    state: 'running',
    approvedVersion: 1,
    closeTarget: null,
    chainCount: 0,
    linkedJobId: null,
    holds: [],
    pendingPlan: null,
    crewNeedingYou: 0,
    sessionId: 'job-session',
    handoffDone: true,
    budgetUsd: 10,
    createdAt: 1,
    updatedAt: 1,
    ...over
  };
}
