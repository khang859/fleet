import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgencyJob } from '../../../shared/agency';
import type { AgencyStore } from '../store/agency-store';
import { REPO, YES_NO, openJob, storeFixture } from './fixture';

let store: AgencyStore;
let cleanup: () => void;
let job: AgencyJob;

beforeEach(() => {
  ({ store, cleanup } = storeFixture());
  job = openJob(store);
});
afterEach(() => cleanup());

const ask = (extra: Partial<Parameters<AgencyStore['askQuestion']>[0]> = {}) =>
  store.askQuestion({
    repoId: REPO.repoId,
    jobId: job.id,
    question: 'Use the new API?',
    options: YES_NO,
    ...extra
  });
const status = (id: number): string | undefined => store.getQuestion(id)?.status;

describe('asking', () => {
  it('stores a question with its options and the recommended one', () => {
    const q = ask({ context: 'The old one is deprecated', recommended: 0, step: 's1' });
    expect(q).toMatchObject({
      status: 'open',
      kind: 'ask',
      options: YES_NO,
      recommended: 0,
      context: 'The old one is deprecated',
      step: 's1',
      dependsOn: null,
      late: false
    });
  });

  it('refuses too few or too many options, and a recommendation that is not one', () => {
    expect(() => ask({ options: [{ label: 'Only' }] })).toThrow(/two to four/);
    expect(() =>
      ask({ options: Array.from({ length: 5 }, (_, i) => ({ label: `${i}` })) })
    ).toThrow(/two to four/);
    expect(() => ask({ recommended: 2 })).toThrow(/not one of the options/);
  });

  it('refuses to depend on a question in another job or on an option it lacks', () => {
    const parent = ask();
    const other = openJob(store);
    expect(() =>
      store.askQuestion({
        repoId: REPO.repoId,
        jobId: other.id,
        question: 'Then?',
        options: YES_NO,
        dependsOn: { question: parent.id, option: 0 }
      })
    ).toThrow(/not a question in this job/);
    expect(() => ask({ dependsOn: { question: parent.id, option: 5 } })).toThrow(/no option 6/);
  });
});

describe('dependsOn', () => {
  it('hides a dependent until its parent is answered, then reveals or withdraws it', () => {
    const parent = ask();
    const ifYes = ask({
      question: 'Which version?',
      dependsOn: { question: parent.id, option: 0 }
    });
    const ifNo = ask({ question: 'Why not?', dependsOn: { question: parent.id, option: 1 } });
    const grandchild = ask({ question: 'Pin it?', dependsOn: { question: ifNo.id, option: 0 } });
    expect([status(ifYes.id), status(ifNo.id), status(grandchild.id)]).toEqual([
      'hidden',
      'hidden',
      'hidden'
    ]);

    const outcome = store.answerQuestion({ id: parent.id, option: 0 });
    expect(outcome?.revealed).toEqual([ifYes.id]);
    expect(outcome?.withdrew).toEqual([ifNo.id, grandchild.id]);
    expect(status(ifYes.id)).toBe('open');
    expect(store.getQuestion(ifNo.id)?.withdrawnReason).toBe(
      `q${parent.id} was answered with another option`
    );
    expect(store.getQuestion(grandchild.id)?.withdrawnReason).toBe(`q${ifNo.id} was withdrawn`);
  });

  it('settles a dependent asked after its parent was already answered', () => {
    const parent = ask();
    store.answerQuestion({ id: parent.id, option: 1 });
    expect(status(ask({ dependsOn: { question: parent.id, option: 1 } }).id)).toBe('open');
    expect(status(ask({ dependsOn: { question: parent.id, option: 0 } }).id)).toBe('withdrawn');
  });

  it('withdraws the dependents along with a withdrawn question', () => {
    const parent = ask();
    const child = ask({ dependsOn: { question: parent.id, option: 0 } });
    expect(store.withdrawQuestion(parent.id, 'the plan changed')?.status).toBe('withdrawn');
    expect(store.getQuestion(child.id)?.withdrawnReason).toBe(`q${parent.id} was withdrawn`);
    expect(status(ask({ dependsOn: { question: parent.id, option: 0 } }).id)).toBe('withdrawn');
  });
});

describe('answering', () => {
  it('records the answer and queues a wakeup for the job', () => {
    const q = ask();
    const outcome = store.answerQuestion({ id: q.id, option: 1, text: '  not yet  ' });
    expect(outcome?.question).toMatchObject({
      status: 'answered',
      answerOption: 1,
      answerText: 'not yet',
      late: false,
      answeredAt: 1_000_000
    });
    const pull = store.pullWakeups({ repoId: REPO.repoId, jobId: job.id });
    expect(pull.ids).toHaveLength(1);
    expect(pull.text).toContain(`Client answered q${q.id}`);
  });

  it('takes free text alone', () => {
    const q = ask();
    expect(store.answerQuestion({ id: q.id, text: 'Ask me tomorrow' })?.question.answerText).toBe(
      'Ask me tomorrow'
    );
  });

  it('refuses a hidden question, a second answer, a missing option and an empty answer', () => {
    const q = ask();
    const hidden = ask({ dependsOn: { question: q.id, option: 0 } });
    expect(store.answerQuestion({ id: hidden.id, option: 0 })).toBeNull();
    expect(store.answerQuestion({ id: q.id, option: 7 })).toBeNull();
    expect(store.answerQuestion({ id: q.id, text: '   ' })).toBeNull();
    expect(store.answerQuestion({ id: 999, option: 0 })).toBeNull();
    expect(store.answerQuestion({ id: q.id, option: 0 })).not.toBeNull();
    expect(store.answerQuestion({ id: q.id, option: 1 })).toBeNull();
    expect(store.getQuestion(q.id)?.answerOption).toBe(0);
  });

  it('keeps an answer to a withdrawn question as late, delivers it once, and refuses a second', () => {
    const q = ask();
    store.withdrawQuestion(q.id, 'the step was dropped');
    const outcome = store.answerQuestion({ id: q.id, option: 0 });
    expect(outcome?.question).toMatchObject({ status: 'withdrawn', late: true, answerOption: 0 });
    expect(store.answerQuestion({ id: q.id, option: 1 })).toBeNull();

    const text = store.pullWakeups({ repoId: REPO.repoId, jobId: job.id }).text;
    expect(text).toContain(`Client answered q${q.id} (late)`);
    expect(text).toContain('had been withdrawn (the step was dropped)');
  });

  it('withdraws every open or hidden question tied to a plan step', () => {
    const a = ask({ step: 's2' });
    const b = ask({ step: 's2', dependsOn: { question: a.id, option: 0 } });
    const answered = ask({ step: 's2' });
    store.answerQuestion({ id: answered.id, option: 0 });
    const elsewhere = ask({ step: 's3' });

    expect(store.withdrawForStep({ jobId: job.id, step: 's2', reason: 's2 was cut' })).toEqual([
      a.id,
      b.id
    ]);
    expect(status(answered.id)).toBe('answered');
    expect(status(elsewhere.id)).toBe('open');
  });

  it('withdraws every open question of a job, whatever its step', () => {
    const a = ask({ step: 's2' });
    const b = ask();
    const answered = ask();
    store.answerQuestion({ id: answered.id, option: 0 });

    expect(store.withdrawForJob({ jobId: job.id, reason: 'the job delivered' })).toEqual([
      a.id,
      b.id
    ]);
    expect(status(answered.id)).toBe('answered');
  });
});
