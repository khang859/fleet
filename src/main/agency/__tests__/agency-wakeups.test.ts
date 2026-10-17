import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAKEUP_GIVE_UP_ATTEMPTS, WAKEUP_STALE_CLAIM_MS } from '../backoff';
import type { AgencyStore } from '../store/agency-store';
import { AgencyStore as Store } from '../store/agency-store';
import { OTHER_REPO, REPO, YES_NO, openJob, storeFixture } from './fixture';

let store: AgencyStore;
let clock: { now: number };
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ store, clock, dbPath, cleanup } = storeFixture());
});
afterEach(() => cleanup());

const event = (
  jobId: number | null,
  line: string,
  extra: { priority?: number; body?: string } = {}
) =>
  store.enqueueWakeup({
    repoId: REPO.repoId,
    jobId,
    kind: 'event',
    payload: { line, body: extra.body },
    priority: extra.priority
  });
const pull = (jobId: number | null) => store.pullWakeups({ repoId: REPO.repoId, jobId });

describe('wakeup lease', () => {
  it('claims every due wakeup of one job as one text, most urgent first', () => {
    const job = openJob(store);
    const a = event(job.id, 'crew a finished');
    const b = event(job.id, 'permission asked', { priority: 5, body: 'rm -rf build' });

    const first = pull(job.id);
    expect(first.ids).toEqual([b, a]);
    expect(first.text).toBe(
      'permission asked · crew a finished\n\n<session-data session="event">\nrm -rf build\n</session-data>'
    );
    expect(first.nextDueAt).toBeNull();
    // Claimed, so a second pull while the turn runs gets nothing.
    expect(pull(job.id)).toEqual({ ids: [], text: null, nextDueAt: null });
  });

  it("never hands one job's wakeups to another job, the lobby or another repository", () => {
    const jobA = openJob(store);
    const jobB = openJob(store);
    const forA = event(jobA.id, 'for a');
    const forLobby = event(null, 'for the lobby');
    store.enqueueWakeup({
      repoId: OTHER_REPO.repoId,
      jobId: null,
      kind: 'event',
      payload: { line: 'other repo' }
    });

    expect(pull(jobB.id).ids).toEqual([]);
    expect(pull(null).ids).toEqual([forLobby]);
    expect(pull(jobA.id).ids).toEqual([forA]);
  });

  it('settles acked wakeups for good', () => {
    const job = openJob(store);
    const id = event(job.id, 'done');
    pull(job.id);
    expect(store.ackWakeups([id])).toEqual([{ repoId: REPO.repoId, jobId: job.id }]);
    clock.now += WAKEUP_STALE_CLAIM_MS * 2;
    expect(pull(job.id).ids).toEqual([]);
  });

  it('hands a claim back out once it is stale, and every claim at startup', () => {
    const job = openJob(store);
    const id = event(job.id, 'done');
    pull(job.id);
    clock.now += WAKEUP_STALE_CLAIM_MS - 1;
    expect(pull(job.id).ids).toEqual([]);
    clock.now += 2;
    expect(pull(job.id).ids).toEqual([id]);

    // A restart: whatever was claimed before it is due again at once.
    expect(store.releaseStaleClaims(0)).toBe(1);
    expect(pull(job.id).ids).toEqual([id]);
  });

  it('survives a reopen of the database with the queue intact', () => {
    const job = openJob(store);
    const id = event(job.id, 'queued');
    store.close();
    const reopened = new Store(dbPath, { now: () => clock.now });
    expect(reopened.pullWakeups({ repoId: REPO.repoId, jobId: job.id }).ids).toEqual([id]);
    store = reopened;
  });
});

describe('failed turns', () => {
  it('backs a released wakeup off by 5s, 15s, 45s, then every 120s', () => {
    const job = openJob(store);
    const id = event(job.id, 'crew done');
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(pull(job.id).ids).toEqual([id]);
      const released = store.releaseWakeups({ ids: [id], error: 'HTTP 503' });
      waits.push((released.nextDueAt ?? 0) - clock.now);
      expect(pull(job.id).ids).toEqual([]);
      clock.now = released.nextDueAt ?? clock.now;
    }
    expect(waits).toEqual([5_000, 15_000, 45_000, 120_000, 120_000, 120_000]);
  });

  it('tells the client once it gives up, holds the job, and recovers when a turn goes through', () => {
    const job = openJob(store);
    store.setJobState(job.id, 'running', 'go');
    const id = event(job.id, 'crew done');

    let gaveUp = false;
    let due: number | null = null;
    for (let attempt = 1; attempt <= WAKEUP_GIVE_UP_ATTEMPTS; attempt++) {
      if (due !== null) clock.now = due;
      pull(job.id);
      const released = store.releaseWakeups({ ids: [id], error: 'HTTP 503' });
      ({ gaveUp, nextDueAt: due } = released);
      expect(gaveUp).toBe(attempt === WAKEUP_GIVE_UP_ATTEMPTS);
    }
    expect(gaveUp).toBe(true);
    const notices = () =>
      store
        .listQuestions(REPO.repoId, { jobId: job.id, statuses: ['open'] })
        .filter((q) => q.kind === 'model_unreachable');
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.context).toContain('HTTP 503');
    expect(store.getJob(job.id)?.state).toBe('waiting');
    expect(store.snapshot(REPO.repoId).nextRetryAt).toBe(clock.now + 120_000);

    // Still failing: still one card.
    clock.now += 120_000;
    pull(job.id);
    store.releaseWakeups({ ids: [id], error: 'HTTP 503' });
    expect(notices()).toHaveLength(1);

    clock.now += 120_000;
    pull(job.id);
    store.ackWakeups([id]);
    expect(notices()).toHaveLength(0);
    expect(store.getJob(job.id)?.state).toBe('running');
  });

  it("makes the queue due now on the card's Retry, without waking the Admiral itself", () => {
    const id = event(null, 'lobby event');
    for (let attempt = 0; attempt < WAKEUP_GIVE_UP_ATTEMPTS; attempt++) {
      pull(null);
      clock.now = store.releaseWakeups({ ids: [id], error: 'timeout' }).nextDueAt ?? clock.now;
    }
    pull(null);
    store.releaseWakeups({ ids: [id], error: 'timeout' });
    const notice = store
      .listQuestions(REPO.repoId, { jobId: null, statuses: ['open'] })
      .find((q) => q.kind === 'model_unreachable');
    expect(notice?.options.map((o) => o.label)).toEqual(['Retry', 'Open Settings']);

    expect(pull(null).ids).toEqual([]);
    store.answerQuestion({ id: notice?.id ?? 0, option: 0 });
    // The retried event, and no wakeup of its own for the notice.
    expect(pull(null)).toMatchObject({ ids: [id], text: 'lobby event' });
  });

  it('wakes the lobby with an answer to a lobby question', () => {
    const q = store.askQuestion({
      repoId: REPO.repoId,
      jobId: null,
      question: 'Start now?',
      options: YES_NO
    });
    store.answerQuestion({ id: q.id, option: 0 });
    expect(pull(null).text).toContain(`Client answered q${q.id}`);
  });
});
