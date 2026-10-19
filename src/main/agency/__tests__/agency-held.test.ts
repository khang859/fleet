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

const { openJob, propose, approve } = planHelpers(() => service, PLAN);

const state = (jobId: number): string | undefined => service.store.getJob(jobId)?.state;
const snapshot = (): ReturnType<AgencyService['snapshot']> => service.snapshot(REPO.repoId);

/** Track how a hold settles without awaiting it. */
function track(p: Promise<HoldResult>): { result: HoldResult | null } {
  const out: { result: HoldResult | null } = { result: null };
  void p.then((r) => (out.result = r));
  return out;
}

describe('held decisions', () => {
  it('holds an approval for undo, and Undo leaves the plan waiting', async () => {
    const { job, tools } = openJob();
    const v1 = await propose(tools);

    const held = track(
      service.hold({ kind: 'plan', action: { planVersionId: v1, action: 'approve' } })
    );
    expect(snapshot().held).toEqual([
      {
        id: 1,
        jobId: job.id,
        key: `plan:${v1}`,
        label: 'Approved plan v1',
        runsAt: clock + HOLD_MS
      }
    ]);
    expect(service.undo(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(held.result).toEqual({ outcome: 'undone' });
    expect(snapshot().held).toEqual([]);
    expect(service.store.plans.version(v1)?.status).toBe('proposed');
    expect(state(job.id)).toBe('planned');
    expect(service.undo(1)).toBe(false);
  });

  it('carries the approval out once its time comes', async () => {
    const { job, tools } = openJob();
    const v1 = await propose(tools);

    const hold = service.hold({ kind: 'plan', action: { planVersionId: v1, action: 'approve' } });
    const held = track(hold);
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(held.result).toBeNull();
    expect(state(job.id)).toBe('planned');
    await vi.advanceTimersByTimeAsync(1);

    // The approval's checks read git, so it settles a little after its time.
    expect(await hold).toEqual({ outcome: 'done' });
    expect(state(job.id)).toBe('running');
    expect(snapshot().held).toEqual([]);
  });

  it('reports a refusal when the plan moved on during the hold', async () => {
    const { tools } = openJob();
    const v1 = await propose(tools);

    const hold = service.hold({ kind: 'plan', action: { planVersionId: v1, action: 'approve' } });
    await propose(tools, { ...PLAN, summary: 'Add dark mode everywhere.' });
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(await hold).toEqual({ outcome: 'refused', reason: 'Plan v1 was replaced by v2.' });
  });

  it('refuses at once what no longer waits, and a second hold on the same item', async () => {
    const { job, tools } = openJob();
    const v1 = await propose(tools);
    void service.hold({
      kind: 'plan',
      action: { planVersionId: v1, action: 'reject', note: 'No' }
    });

    expect(
      await service.hold({ kind: 'plan', action: { planVersionId: v1, action: 'approve' } })
    ).toEqual({ outcome: 'refused', reason: 'A decision on this is already held.' });
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(state(job.id)).toBe('briefing');
    expect(
      await service.hold({ kind: 'plan', action: { planVersionId: v1, action: 'approve' } })
    ).toEqual({ outcome: 'refused', reason: 'Plan v1 is already rejected.' });
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
  it("lists the client's plan and question decisions since local midnight, newest first", async () => {
    const yesterday = openJob('Yesterday');
    clock -= 13 * 60 * 60 * 1000;
    await approve(yesterday.tools);
    clock += 13 * 60 * 60 * 1000;

    const { job, tools } = openJob();
    const v1 = await propose(tools);
    await service.jobs.decide({
      planVersionId: v1,
      action: 'revise',
      note: 'Smaller, please',
      steps: []
    });
    clock += 1_000;
    await approve(tools);
    clock += 1_000;
    await tools.askClient({ question: 'Dark by default?', options: YES_NO });
    const asked = snapshot().questions.find((q) => q.status === 'open');
    service.answer({ id: asked!.id, option: 1 });

    expect(snapshot().decisions).toEqual([
      expect.objectContaining({
        key: `q:${asked!.id}`,
        label: `Answered q${asked!.id}`,
        detail: 'No'
      }),
      expect.objectContaining({ label: 'Approved plan v2', jobId: job.id, jobState: 'running' }),
      expect.objectContaining({
        key: `plan:${v1}`,
        label: 'Asked for a change to plan v1',
        detail: 'Smaller, please'
      })
    ]);
  });
});
