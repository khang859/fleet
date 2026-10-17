import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgencyStore } from '../store/agency-store';
import { OTHER_REPO, REPO, YES_NO, openJob, storeFixture } from './fixture';

let store: AgencyStore;
let clock: { now: number };
let cleanup: () => void;

beforeEach(() => {
  ({ store, clock, cleanup } = storeFixture());
});
afterEach(() => cleanup());

describe('lobbies', () => {
  it('mints a lobby session once per repository and keeps it', () => {
    let minted = 0;
    const mint = (): string => `lobby-${++minted}`;
    expect(store.ensureLobby(REPO, mint)).toBe('lobby-1');
    expect(store.ensureLobby({ ...REPO, root: '/moved/fleet' }, mint)).toBe('lobby-1');
    expect(store.ensureLobby(OTHER_REPO, mint)).toBe('lobby-2');
    expect(store.lobbySessionId(REPO.repoId)).toBe('lobby-1');
    expect(store.lobbySessionId('0000000000000000')).toBeNull();
  });

  it('remembers the last lobby message carried into a job, idempotently', () => {
    store.ensureLobby(REPO);
    const job = openJob(store);
    expect(store.lastHandoffMessageId(REPO.repoId)).toBeNull();
    expect(store.markHandoff({ jobId: job.id, lobbyMessageId: 'm-7' })?.handoffDone).toBe(true);
    expect(store.markHandoff({ jobId: job.id, lobbyMessageId: 'm-7' })?.handoffDone).toBe(true);
    expect(store.lastHandoffMessageId(REPO.repoId)).toBe('m-7');
    expect(store.markHandoff({ jobId: 999, lobbyMessageId: 'm-8' })).toBeNull();
  });
});

describe('jobs', () => {
  it('opens a job in briefing and records why each state was entered', () => {
    const job = store.openJob({
      repoId: REPO.repoId,
      title: 'Ship it',
      brief: 'ship the thing',
      sessionId: 'sess-a',
      budgetUsd: 25
    });
    expect(job).toMatchObject({ state: 'briefing', budgetUsd: 25, handoffDone: false });

    clock.now += 10;
    expect(store.setJobState(job.id, 'running', 'plan approved')?.state).toBe('running');
    expect(store.jobEvents(job.id)).toEqual([
      { jobId: job.id, at: 1_000_000, from: null, to: 'briefing', reason: 'opened' },
      { jobId: job.id, at: 1_000_010, from: 'briefing', to: 'running', reason: 'plan approved' }
    ]);
    expect(store.getJob(job.id)?.updatedAt).toBe(1_000_010);
  });

  it('lists only open jobs unless asked, and running ones across repositories', () => {
    const a = openJob(store);
    const b = openJob(store);
    const c = openJob(store, OTHER_REPO.repoId);
    store.setJobState(a.id, 'running', 'go');
    store.setJobState(b.id, 'closed', 'done');
    store.setJobState(c.id, 'waiting', 'question');

    expect(store.listJobs(REPO.repoId).map((j) => j.id)).toEqual([a.id]);
    expect(store.listJobs(REPO.repoId, { includeTerminal: true }).map((j) => j.id)).toEqual([
      a.id,
      b.id
    ]);
    expect(store.listRunning().map((j) => j.id)).toEqual([a.id, c.id]);
  });

  it('cancels running jobs, withdrawing their questions and dropping their wakeups', () => {
    const running = openJob(store);
    const briefing = openJob(store);
    const done = openJob(store);
    store.setJobState(running.id, 'running', 'go');
    store.setJobState(done.id, 'closed', 'done');
    const q = store.askQuestion({
      repoId: REPO.repoId,
      jobId: running.id,
      question: 'Which?',
      options: YES_NO
    });
    store.enqueueWakeup({
      repoId: REPO.repoId,
      jobId: running.id,
      kind: 'event',
      payload: { line: 'crew finished' }
    });

    expect(store.cancelJobs(REPO.repoId)).toEqual([running.id]);
    expect(store.getJob(running.id)?.state).toBe('cancelled');
    expect(store.getJob(briefing.id)?.state).toBe('briefing');
    expect(store.getJob(done.id)?.state).toBe('closed');
    expect(store.getQuestion(q.id)).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'the job was cancelled'
    });
    expect(store.pullWakeups({ repoId: REPO.repoId, jobId: running.id }).ids).toEqual([]);
  });
});

describe('snapshot', () => {
  it("shows a repository's lobby, open jobs and questions, and nothing of another's", () => {
    store.ensureLobby(REPO, () => 'lobby-a');
    const job = openJob(store);
    openJob(store, OTHER_REPO.repoId);
    const open = store.askQuestion({
      repoId: REPO.repoId,
      jobId: job.id,
      question: 'A?',
      options: YES_NO
    });
    const answered = store.askQuestion({
      repoId: REPO.repoId,
      jobId: null,
      question: 'B?',
      options: YES_NO
    });
    store.answerQuestion({ id: answered.id, option: 1 });
    store.askQuestion({
      repoId: OTHER_REPO.repoId,
      jobId: null,
      question: 'C?',
      options: YES_NO
    });

    const snap = store.snapshot(REPO.repoId);
    expect(snap.lobbySessionId).toBe('lobby-a');
    expect(snap.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(snap.questions.map((q) => [q.id, q.status])).toEqual([
      [open.id, 'open'],
      [answered.id, 'answered']
    ]);
    expect(snap.nextRetryAt).toBeNull();
  });
});
