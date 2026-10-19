import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAKEUP_GIVE_UP_ATTEMPTS } from '../backoff';
import { DEFAULT_AGENCY_SETTINGS } from '../../../shared/agency';
import { chainLimit } from '../jobs/chain';
import type { AgencyStore } from '../store/agency-store';
import { REPO, YES_NO, moveJob, openJob, storeFixture } from './fixture';

let store: AgencyStore;
let clock: { now: number };
let cleanup: () => void;

beforeEach(() => {
  ({ store, clock, cleanup } = storeFixture());
});
afterEach(() => cleanup());

function event(jobId: number, line: string): number {
  return store.enqueueWakeup({ repoId: REPO.repoId, jobId, kind: 'event', payload: { line } });
}
function pull(jobId: number): ReturnType<AgencyStore['pullWakeups']> {
  return store.pullWakeups({ repoId: REPO.repoId, jobId });
}
function approve(jobId: number): void {
  moveJob(store, jobId, 'running');
  // Turns count only inside an approved plan.
  store['db'].prepare('UPDATE jobs SET approved_version = 1 WHERE id = ?').run(jobId);
}
function openCards(jobId: number, kind: string): number {
  return store
    .listQuestions(REPO.repoId, { jobId, statuses: ['open'] })
    .filter((q) => q.kind === kind).length;
}

describe('holds', () => {
  it('keeps a running job waiting until every hold is gone', () => {
    const job = openJob(store);
    moveJob(store, job.id, 'running');
    store.addHold(job.id, 'model', 'HTTP 503');
    store.addHold(job.id, 'client');
    expect(store.getJob(job.id)).toMatchObject({ state: 'waiting', holds: ['model', 'client'] });

    store.releaseHold(job.id, 'model');
    expect(store.getJob(job.id)?.state).toBe('waiting');
    store.releaseHold(job.id, 'client');
    expect(store.getJob(job.id)).toMatchObject({ state: 'running', holds: [] });
    expect(store.jobEvents(job.id).map((e) => e.reason)).toContain('waiting on model');
  });

  it('records a hold on a job that is not running yet, and applies it once it runs', () => {
    const job = openJob(store);
    store.addHold(job.id, 'model');
    expect(store.getJob(job.id)).toMatchObject({ state: 'briefing', holds: ['model'] });

    moveJob(store, job.id, 'running');
    expect(store.getJob(job.id)?.state).toBe('waiting');
  });

  it('keeps waiting on an open question after the model comes back', () => {
    const job = openJob(store);
    moveJob(store, job.id, 'running');
    store.addHold(job.id, 'client');
    const id = event(job.id, 'crew done');
    for (let attempt = 0; attempt < WAKEUP_GIVE_UP_ATTEMPTS; attempt++) {
      pull(job.id);
      clock.now = store.releaseWakeups({ ids: [id], error: 'timeout' }).nextDueAt ?? clock.now;
    }
    expect(store.getJob(job.id)?.holds).toEqual(['model', 'client']);

    pull(job.id);
    store.ackWakeups([id]);
    expect(store.getJob(job.id)).toMatchObject({ state: 'waiting', holds: ['client'] });
  });

  it('drops holds when the job closes', () => {
    const job = openJob(store);
    moveJob(store, job.id, 'running');
    store.addHold(job.id, 'model');
    store.beginClose(job.id, { type: 'cancel' }, 'client cancelled');
    expect(store.getJob(job.id)).toMatchObject({ state: 'closing', holds: [] });
  });
});

const CHAIN_LIMIT = DEFAULT_AGENCY_SETTINGS.admiral.turnLimit;

describe('automatic turn limit', () => {
  it('runs up to the limit, then waits behind one "continue?" card', () => {
    const job = openJob(store);
    approve(job.id);
    for (let turn = 0; turn < CHAIN_LIMIT; turn++) {
      const id = event(job.id, `crew update ${turn}`);
      expect(pull(job.id).ids).toEqual([id]);
      store.ackWakeups([id]);
    }
    const next = event(job.id, 'one more');
    expect(pull(job.id)).toEqual({ ids: [], text: null, nextDueAt: null });
    expect(pull(job.id).ids).toEqual([]);
    expect(openCards(job.id, 'continue')).toBe(1);
    expect(store.getJob(job.id)).toMatchObject({ state: 'waiting', holds: ['chain_limit'] });

    const card = store
      .listQuestions(REPO.repoId, { jobId: job.id, statuses: ['open'] })
      .find((q) => q.kind === 'continue');
    store.answerQuestion({ id: card?.id ?? 0, option: 0 });
    expect(store.getJob(job.id)).toMatchObject({ state: 'running', chainCount: 0, holds: [] });
    expect(pull(job.id).ids).toEqual([next]);
  });

  it('starts counting again on a client message, an answer, and not before approval', () => {
    const job = openJob(store);
    for (let turn = 0; turn < CHAIN_LIMIT + 5; turn++) {
      const id = event(job.id, 'briefing chatter');
      expect(pull(job.id).ids).toEqual([id]);
      store.ackWakeups([id]);
    }
    expect(store.getJob(job.id)?.chainCount).toBe(0);

    approve(job.id);
    for (let turn = 0; turn < CHAIN_LIMIT - 1; turn++) {
      store.ackWakeups(pull(job.id).ids.concat(event(job.id, 'x')));
      pull(job.id);
    }
    store.resetChain(job.id);
    expect(store.getJob(job.id)?.chainCount).toBe(0);

    const q = store.askQuestion({
      repoId: REPO.repoId,
      jobId: job.id,
      question: 'Which?',
      options: YES_NO
    });
    store['db'].prepare('UPDATE jobs SET chain_count = 7 WHERE id = ?').run(job.id);
    store.answerQuestion({ id: q.id, option: 0 });
    expect(store.getJob(job.id)?.chainCount).toBe(0);
  });

  it('lets a client message lift the pause and take the card down', () => {
    const job = openJob(store);
    approve(job.id);
    store['db'].prepare('UPDATE jobs SET chain_count = ? WHERE id = ?').run(CHAIN_LIMIT, job.id);
    event(job.id, 'x');
    pull(job.id);
    expect(openCards(job.id, 'continue')).toBe(1);

    store.resetChain(job.id);
    expect(openCards(job.id, 'continue')).toBe(0);
    expect(store.getJob(job.id)).toMatchObject({ state: 'running', holds: [] });
  });

  it('defaults to 20 turns', () => {
    expect(CHAIN_LIMIT).toBe(20);
    const job = openJob(store);
    approve(job.id);
    store['db'].prepare('UPDATE jobs SET chain_count = ? WHERE id = ?').run(19, job.id);
    event(job.id, 'x');
    expect(pull(job.id).ids).toHaveLength(1);
    event(job.id, 'y');
    expect(pull(job.id).ids).toEqual([]);
    expect(openCards(job.id, 'continue')).toBe(1);
  });

  it('pauses at the configured limit and says that number on the card', () => {
    cleanup();
    let limit = 4;
    ({ store, clock, cleanup } = storeFixture({ turnLimit: () => limit }));
    const job = openJob(store);
    approve(job.id);
    for (let turn = 0; turn < 4; turn++) {
      const id = event(job.id, `crew update ${turn}`);
      expect(pull(job.id).ids).toEqual([id]);
      store.ackWakeups([id]);
    }
    event(job.id, 'one more');
    expect(pull(job.id).ids).toEqual([]);
    expect(store.getJob(job.id)).toMatchObject({ holds: ['chain_limit'] });

    const card = store
      .listQuestions(REPO.repoId, { jobId: job.id, statuses: ['open'] })
      .find((q) => q.kind === 'continue');
    expect(card?.question).toBe('The Admiral took 4 turns in a row on its own');
    expect(card?.options[0]).toEqual({ label: 'Continue', detail: '4 more turns' });

    // A changed setting applies to the next count.
    limit = 6;
    store.resetChain(job.id);
    for (let turn = 0; turn < 6; turn++) {
      store.ackWakeups(pull(job.id).ids);
      event(job.id, `again ${turn}`);
    }
    expect(store.getJob(job.id)?.chainCount).toBe(6);
    store.ackWakeups(pull(job.id).ids);
    event(job.id, 'past six');
    expect(pull(job.id).ids).toEqual([]);
    expect(store.getJob(job.id)).toMatchObject({ holds: ['chain_limit'] });
    const again = store
      .listQuestions(REPO.repoId, { jobId: job.id, statuses: ['open'] })
      .find((q) => q.kind === 'continue');
    expect(again?.question).toBe('The Admiral took 6 turns in a row on its own');
    expect(again?.options[0]).toEqual({ label: 'Continue', detail: '6 more turns' });
  });
});

describe('chainLimit', () => {
  const admiral = DEFAULT_AGENCY_SETTINGS.admiral;

  it('reads the configured limit', () => {
    expect(chainLimit({ ...admiral, turnLimit: 50 })).toBe(50);
  });

  it('falls back to 20 when the stored value is missing or out of range', () => {
    for (const turnLimit of [undefined, 0, -3, 1.5, 201, Number.NaN]) {
      expect(chainLimit({ ...admiral, turnLimit: turnLimit as number })).toBe(20);
    }
  });
});
