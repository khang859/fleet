import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HoldResult } from '../../../shared/agency-jobs';
import type { PlanInput } from '../../../shared/agency-plan';
import { AgencyService } from '../index';
import { HOLD_MS } from '../held-decisions';
import { factsGit, fakeGh, REPO, YES_NO } from './fixture';
import { planHelpers } from './plan-helpers';

let dir: string;
let service: AgencyService;
/** Local noon of a fixed day, so "since midnight" is easy to cross. */
let clock: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-held-'));
  clock = new Date(2026, 9, 18, 12, 0, 0).getTime();
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    git: factsGit(),
    gh: fakeGh(),
    now: () => clock
  });
  service.ensureLobby(REPO);
});
afterEach(() => {
  service.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode to the settings page.',
  steps: [{ id: 'builder-1', role: 'builder', title: 'Build the toggle' }],
  budget: { usd: 10 }
};

const { openJob } = planHelpers(() => service, PLAN);

const snapshot = (): ReturnType<AgencyService['snapshot']> => service.snapshot(REPO.repoId);

/** Track how a hold settles without awaiting it. */
function track(p: Promise<HoldResult>): { result: HoldResult | null } {
  const out: { result: HoldResult | null } = { result: null };
  void p.then((r) => (out.result = r));
  return out;
}

describe('held decisions', () => {
  /** A job with one open question, and that question. */
  async function asked(): Promise<{ jobId: number; questionId: number }> {
    const { job, tools } = openJob();
    await tools.askClient({ question: 'Dark by default?', options: YES_NO });
    return { jobId: job.id, questionId: snapshot().questions[0].id };
  }

  it('holds an answer for undo, and Undo leaves the question open', async () => {
    const { jobId, questionId } = await asked();

    const held = track(service.hold({ kind: 'answer', answer: { id: questionId, option: 0 } }));
    expect(snapshot().held).toEqual([
      {
        id: 1,
        jobId,
        key: `q:${questionId}`,
        label: `Answered q${questionId}`,
        runsAt: clock + HOLD_MS
      }
    ]);
    expect(service.undo(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(held.result).toEqual({ outcome: 'undone' });
    expect(snapshot().held).toEqual([]);
    expect(service.store.getQuestion(questionId)?.status).toBe('open');
    expect(service.undo(1)).toBe(false);
  });

  it('carries the answer out once its time comes', async () => {
    const { questionId } = await asked();

    const held = track(service.hold({ kind: 'answer', answer: { id: questionId, option: 0 } }));
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(held.result).toBeNull();
    expect(service.store.getQuestion(questionId)?.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1);

    expect(held.result).toEqual({ outcome: 'done' });
    expect(service.store.getQuestion(questionId)?.status).toBe('answered');
    expect(snapshot().held).toEqual([]);
  });

  it('refuses at once what no longer waits, and a second hold on the same item', async () => {
    const { questionId } = await asked();
    void service.hold({ kind: 'answer', answer: { id: questionId, option: 0 } });

    expect(await service.hold({ kind: 'answer', answer: { id: questionId, option: 1 } })).toEqual({
      outcome: 'refused',
      reason: 'A decision on this is already held.'
    });
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(await service.hold({ kind: 'answer', answer: { id: questionId, option: 1 } })).toEqual({
      outcome: 'refused',
      reason: `q${questionId} is not open.`
    });
  });

  it('sends a held answer at once when Fleet quits', async () => {
    const { tools } = openJob();
    await tools.askClient({ question: 'Dark by default?', options: YES_NO });
    const [question] = snapshot().questions;

    const held = track(service.hold({ kind: 'answer', answer: { id: question.id, option: 0 } }));
    expect(service.hasHeld()).toBe(true);
    await service.runHeld();

    expect(held.result).toEqual({ outcome: 'done' });
    expect(service.hasHeld()).toBe(false);
    expect(service.store.getQuestion(question.id)).toMatchObject({
      status: 'answered',
      answerOption: 0
    });
  });

  it('sends a held answer at once when the Admiral pane releases the project', async () => {
    service.claim({ repoId: REPO.repoId, paneId: 'pane-a' }, 1);
    const { tools } = openJob();
    await tools.askClient({ question: 'Dark by default?', options: YES_NO });
    const [question] = snapshot().questions;

    const held = track(service.hold({ kind: 'answer', answer: { id: question.id, option: 1 } }));
    service.release('pane-a');
    await vi.advanceTimersByTimeAsync(0);

    expect(held.result).toEqual({ outcome: 'done' });
    expect(service.store.getQuestion(question.id)?.status).toBe('answered');
  });
});

describe('done today', () => {
  it("lists the client's answers since local midnight, newest first", async () => {
    const { tools } = openJob();
    clock -= 13 * 60 * 60 * 1000;
    await tools.askClient({ question: 'Yesterday?', options: YES_NO });
    const yesterday = snapshot().questions.find((q) => q.status === 'open');
    service.answer({ id: yesterday!.id, option: 0 });
    clock += 13 * 60 * 60 * 1000;

    await tools.askClient({ question: 'Dark by default?', options: YES_NO });
    const first = snapshot().questions.find((q) => q.status === 'open');
    service.answer({ id: first!.id, option: 0 });
    clock += 1_000;
    await tools.askClient({ question: 'Teal accents?', options: YES_NO });
    const second = snapshot().questions.find((q) => q.status === 'open');
    service.answer({ id: second!.id, option: 1 });

    expect(snapshot().decisions).toEqual([
      expect.objectContaining({ key: `q:${second!.id}`, detail: 'No' }),
      expect.objectContaining({ key: `q:${first!.id}`, detail: 'Yes' })
    ]);
  });
});
