import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEET_QUESTION_IDS } from '../../../shared/agency-meet';
import type { AgencyStore } from '../store/agency-store';
import { OTHER_REPO, REPO, YES_NO, moveJob, openJob, storeFixture } from './fixture';

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
    // The job's Admiral wakes once, to plan from the talk carried over.
    const pull = store.pullWakeups({ repoId: REPO.repoId, jobId: job.id });
    expect(pull.ids).toHaveLength(1);
    expect(pull.text).toContain('Job opened from the Bridge');
    expect(store.markHandoff({ jobId: 999, lobbyMessageId: 'm-8' })).toBeNull();
  });

  it('clears the lobby onto a fresh session and leaves every job alone', () => {
    store.ensureLobby(REPO, () => 'lobby-old');
    store.ensureLobby(OTHER_REPO, () => 'other-lobby');
    const job = openJob(store);
    const fresh = store.clearConversation({ repoId: REPO.repoId, jobId: null }, () => 'lobby-new');

    expect(fresh).toBe('lobby-new');
    expect(store.lobbySessionId(REPO.repoId)).toBe('lobby-new');
    // A reload adopts the new lobby, not a freshly minted one.
    expect(store.ensureLobby(REPO, () => 'x')).toBe('lobby-new');
    // Turns on the new session are scoped as the Admiral's.
    expect(store.isAdmiralSession('lobby-new')).toBe(true);
    expect(store.lobbySessionId(OTHER_REPO.repoId)).toBe('other-lobby');
    expect(store.getJob(job.id)?.sessionId).toBe(job.sessionId);
    // A repository with no lobby has nothing to clear.
    expect(store.clearConversation({ repoId: '0000000000000000', jobId: null })).toBeNull();
  });

  it('clears one job onto a fresh session and leaves the lobby and other jobs alone', () => {
    store.ensureLobby(REPO, () => 'lobby-1');
    const job = openJob(store);
    const other = openJob(store, REPO.repoId, 'Another job');
    clock.now += 10;
    const fresh = store.clearConversation({ repoId: REPO.repoId, jobId: job.id }, () => 'job-new');

    expect(fresh).toBe('job-new');
    expect(store.getJob(job.id)).toMatchObject({ sessionId: 'job-new', updatedAt: clock.now });
    expect(store.getJob(other.id)?.sessionId).toBe(other.sessionId);
    expect(store.lobbySessionId(REPO.repoId)).toBe('lobby-1');
    // Not a job of that repository, or no job at all.
    expect(store.clearConversation({ repoId: OTHER_REPO.repoId, jobId: job.id })).toBeNull();
    expect(store.clearConversation({ repoId: REPO.repoId, jobId: 999 })).toBeNull();
    expect(store.getJob(job.id)?.sessionId).toBe('job-new');
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
    expect(store.applyJobEvent(job.id, { type: 'plan_proposed' }, 'plan v1').job?.state).toBe(
      'planned'
    );
    // Refused moves and moves to the same state write nothing.
    expect(store.applyJobEvent(job.id, { type: 'delivered' }, 'x').transition).toEqual({
      ok: false,
      refused: 'a planned job does not take delivered'
    });
    expect(
      store.applyJobEvent(job.id, { type: 'plan_proposed' }, 'plan v2').transition
    ).toMatchObject({ ok: true, changed: false });
    expect(store.jobEvents(job.id)).toEqual([
      { jobId: job.id, at: 1_000_000, from: null, to: 'briefing', reason: 'opened' },
      { jobId: job.id, at: 1_000_010, from: 'briefing', to: 'planned', reason: 'plan v1' }
    ]);
    expect(store.getJob(job.id)?.updatedAt).toBe(1_000_010);
  });

  it('lists only open jobs unless asked, and running ones across repositories', () => {
    const a = openJob(store);
    const b = openJob(store);
    const c = openJob(store, OTHER_REPO.repoId);
    moveJob(store, a.id, 'running');
    moveJob(store, b.id, 'closed');
    moveJob(store, c.id, 'waiting');

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
    moveJob(store, running.id, 'running');
    moveJob(store, done.id, 'closed');
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
    expect(store.getJob(running.id)).toMatchObject({ state: 'closing', closeTarget: 'cancelled' });
    expect(store.getJob(briefing.id)?.state).toBe('briefing');
    expect(store.getJob(done.id)?.state).toBe('closed');
    expect(store.getQuestion(q.id)).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'the job is closing'
    });
    expect(store.pullWakeups({ repoId: REPO.repoId, jobId: running.id }).ids).toEqual([]);

    // A second close joins the first and keeps its end.
    expect(store.beginClose(running.id, { type: 'fail' }, 'x').transition).toMatchObject({
      ok: true,
      changed: false
    });
    expect(store.finishClose(running.id, 'cleanup done')?.state).toBe('cancelled');
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

describe('onboarding', () => {
  it('remembers first run once, across restarts of the store', () => {
    expect(store.firstRunDone()).toBe(false);
    store.finishFirstRun();
    store.finishFirstRun();
    expect(store.firstRunDone()).toBe(true);
  });

  it('marks setup and the starter questions done per repository', () => {
    const fresh = {
      setupDoneAt: null,
      starterDoneAt: null,
      meetDue: true,
      meetLeft: [...MEET_QUESTION_IDS]
    };
    expect(store.onboarding(REPO.repoId)).toEqual(fresh);
    clock.now = 2_000_000;
    store.markOnboarded(REPO, 'setup');
    clock.now = 3_000_000;
    // A project done with the starter questions is asked only the You ones, once.
    const done = {
      setupDoneAt: 2_000_000,
      starterDoneAt: 3_000_000,
      meetDue: true,
      meetLeft: ['report', 'never']
    };
    expect(store.markOnboarded(REPO, 'starter')).toEqual(done);
    expect(store.snapshot(REPO.repoId).onboarding).toEqual(done);
    expect(store.onboarding(OTHER_REPO.repoId)).toEqual(fresh);
  });

  it('lists every project with an Admiral or a setup, with what is running and waiting', () => {
    store.ensureLobby(OTHER_REPO);
    store.markOnboarded(REPO, 'setup');
    const running = openJob(store);
    openJob(store);
    moveJob(store, running.id, 'running');
    store.askQuestion({
      repoId: REPO.repoId,
      jobId: running.id,
      question: 'Which?',
      options: YES_NO
    });

    expect(store.listProjects()).toEqual([
      {
        repo: REPO,
        setupDoneAt: clock.now,
        starterDoneAt: null,
        runningJobs: 1,
        openQuestions: 1
      },
      { repo: OTHER_REPO, setupDoneAt: null, starterDoneAt: null, runningJobs: 0, openQuestions: 0 }
    ]);
  });
});
