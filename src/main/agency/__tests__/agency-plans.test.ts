import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENCY_SETTINGS } from '../../../shared/agency';
import { PlanSchema, type PlanInput } from '../../../shared/agency-plan';
import { AgencyService } from '../index';
import { createAgencyCapability } from '../tools';
import { admiralSnapshotNote } from '../admiral/snapshot-note';
import { factsGit, fakeGh, REPO, YES_NO } from './fixture';
import { planHelpers } from './plan-helpers';

let dir: string;
let dbPath: string;
let service: AgencyService;
let stopped: string[];

const settings = (): typeof DEFAULT_AGENCY_SETTINGS => ({
  ...DEFAULT_AGENCY_SETTINGS,
  enabled: true
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-plans-'));
  dbPath = join(dir, 'agency.db');
  stopped = [];
  service = new AgencyService({
    dbPath,
    emit: () => undefined,
    hasModelKey: () => true,
    git: factsGit(),
    gh: fakeGh(),
    crew: {
      stop: async (paneId) => {
        stopped.push(paneId);
        return Promise.resolve();
      },
      livePanes: () => new Set()
    }
  });
  service.ensureLobby(REPO);
});
afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode to the settings page.',
  steps: [
    { id: 'builder-1', role: 'builder', title: 'Build the toggle' },
    { id: 'reviewer', role: 'reviewer', title: 'Review the change', after: ['builder-1'] }
  ],
  budget: { usd: 10 }
};

const plan = (patch: Partial<PlanInput> = {}): ReturnType<typeof PlanSchema.parse> =>
  PlanSchema.parse({ ...PLAN, ...patch });

const { openJob, propose, startPlan } = planHelpers(() => service, PLAN);

const state = (jobId: number): string | undefined => service.store.getJob(jobId)?.state;
const steps = (jobId: number): Record<string, string> =>
  Object.fromEntries(service.store.plans.steps(jobId).map((s) => [s.id, s.status]));
const wakeupText = (jobId: number): string =>
  service.store.pullWakeups({ repoId: REPO.repoId, jobId }).text ?? '';

/** Write a row the way a later phase would, through a second connection to the same file. */
function sql(statement: string, ...params: unknown[]): void {
  const db = new Database(dbPath);
  db.prepare(statement).run(...params);
  db.close();
}

describe('job_plan', () => {
  it('exists only in a job thread', () => {
    const lobby = createAgencyCapability(service, { repoId: REPO.repoId, jobId: null }, settings);
    expect(lobby.jobPlan).toBeNull();
    expect(lobby.jobUpdate).toBeNull();
  });

  it('starts v1 at once, lays out its steps, and tells the Admiral to hire', async () => {
    const { job, tools } = openJob();

    const out = await tools.jobPlan!(plan());

    expect(out.summary).toMatch(/^started plan v1 plan#\d+$/);
    expect(out.text).toContain('Plan v1 started. Hire for the steps that may start now');
    expect(out.text).toContain('Do not tell the client');
    expect(state(job.id)).toBe('running');
    expect(service.store.getJob(job.id)).toMatchObject({
      approvedVersion: 1,
      budgetUsd: 10,
      pendingPlan: null
    });
    expect(steps(job.id)).toEqual({ 'builder-1': 'pending', reviewer: 'pending' });
    expect(wakeupText(job.id)).toBe('');
    const update = await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    expect(update.text).toContain('is running');
  });

  it('refuses a plan whose steps wait on each other, as a sentence the model can act on', async () => {
    const { job, tools } = openJob();
    const out = await tools.jobPlan!(
      plan({
        steps: [
          { id: 'a', role: 'builder', title: 'A', after: ['b'] },
          { id: 'b', role: 'builder', title: 'B', after: ['a'] }
        ]
      })
    );
    expect(out.summary).toBe('plan refused');
    expect(out.text).toContain('wait on each other in a loop');
    expect(state(job.id)).toBe('briefing');
  });
});

describe('client changes', () => {
  it('lets the client change only the plan the job runs now', async () => {
    const { tools } = openJob();
    const v1 = await startPlan(tools);
    await startPlan(tools, plan({ summary: 'Add dark mode everywhere.' }));

    const result = await service.jobs.decide({ planVersionId: v1, action: 'edit', plan: plan() });

    expect(result).toEqual({ ok: false, reason: 'Only the plan the job runs now can be changed.' });
    expect(service.store.plans.version(v1)?.status).toBe('superseded');
  });

  it("starts the client's edit as their own version", async () => {
    const { job, tools } = openJob();
    const v1 = await startPlan(tools);
    wakeupText(job.id);

    const result = await service.jobs.decide({
      planVersionId: v1,
      action: 'edit',
      plan: { ...PLAN, budget: { usd: 5 } }
    });

    expect(result).toEqual({ ok: true, version: 2 });
    expect(service.store.plans.approved(job.id)).toMatchObject({
      version: 2,
      author: 'client',
      status: 'approved'
    });
    expect(service.store.getJob(job.id)?.budgetUsd).toBe(5);
    expect(wakeupText(job.id)).toContain('Client changed plan v1 into v2');
  });

  it('wakes the Admiral with the steps before and after, to weigh as a lasting preference', async () => {
    const { job, tools } = openJob();
    const v1 = await startPlan(tools);
    await service.jobs.decide({
      planVersionId: v1,
      action: 'edit',
      plan: { ...PLAN, steps: [PLAN.steps[0]] }
    });
    const text = wakeupText(job.id);
    expect(text).toContain(
      'Before: builder: Build the toggle; reviewer: Review the change\nAfter: builder: Build the toggle'
    );
  });
});

describe('changes since the version before', () => {
  const previousOf = (jobId: number, version: number): unknown =>
    service.jobs.detail(jobId)?.versions.find((v) => v.version === version)?.previous;

  it('is null for v1', async () => {
    const { job, tools } = openJob();
    await propose(tools);
    expect(previousOf(job.id, 1)).toBeNull();
  });

  it('measures a change against the v1 it replaced', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    await startPlan(tools, plan({ steps: [PLAN.steps[0]] }));
    expect(previousOf(job.id, 2)).toEqual({
      version: 1,
      status: 'superseded',
      note: null,
      diff: [{ kind: 'removed', step: 'reviewer' }]
    });
  });
});

describe('plan changes', () => {
  it('a change that drops a step stops its crew and withdraws its questions', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    const crew = service.store.crew.insert({
      jobId: job.id,
      stepId: 'reviewer',
      role: 'reviewer',
      runtime: 'claude',
      label: 'reviewer',
      paneId: 'pane-reviewer',
      status: 'running'
    });
    await tools.askClient({ question: 'Strict review?', options: YES_NO, step: 'reviewer' });

    await startPlan(tools, plan({ steps: [PLAN.steps[0]] }));
    await new Promise((r) => setImmediate(r));

    expect(steps(job.id)).toEqual({ 'builder-1': 'pending', reviewer: 'removed' });
    expect(stopped).toEqual(['pane-reviewer']);
    expect(service.store.crew.get(crew.id)?.status).toBe('ended');
    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    expect(question).toMatchObject({ status: 'withdrawn', withdrawnReason: 'step removed' });
    expect(service.store.plans.version(1)?.status).toBe('superseded');
  });

  it('swapping the role of a running step stops its crew, to go on from its branch', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    service.store.crew.insert({
      jobId: job.id,
      stepId: 'builder-1',
      role: 'builder',
      runtime: 'claude',
      label: 'builder',
      paneId: 'pane-builder',
      status: 'running'
    });
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });

    const v2 = await startPlan(
      tools,
      plan({ steps: [{ ...PLAN.steps[0], role: 'senior-builder' }, PLAN.steps[1]] })
    );
    await new Promise((r) => setImmediate(r));

    expect(stopped).toEqual(['pane-builder']);
    expect(service.store.plans.version(v2)?.effects?.swaps).toEqual({ 'builder-1': 'continue' });
  });

  it('a done step cannot change or go', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });

    const out = await tools.jobPlan!(
      plan({ steps: [{ ...PLAN.steps[0], title: 'Redo' }, PLAN.steps[1]] })
    );

    expect(out.text).toContain('Step builder-1 is done, so it cannot change.');
    expect(service.store.plans.pending(job.id)).toBeNull();
  });

  it('a step that delivered something cannot go', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    sql(
      `INSERT INTO results (job_id, step_id, kind, label, listed, title, ref, delivered_at)
       VALUES (?, 'reviewer', 'review', 'Review notes', 1, 'Notes', 'r1', 1)`,
      job.id
    );

    const out = await tools.jobPlan!(plan({ steps: [PLAN.steps[0]] }));

    expect(out.text).toContain('Step reviewer already delivered results, so it cannot be removed.');
  });

  it('the budget cannot go below what was spent', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    sql(
      `INSERT INTO spend_samples (job_id, source, meter, amount, at) VALUES (?, 'crew', 'usd', 7.5, 1)`,
      job.id
    );

    const out = await tools.jobPlan!(plan({ budget: { usd: 5 } }));

    expect(out.text).toContain('cannot go below what the job already spent ($7.50)');
  });
});

describe('job_update', () => {
  it('a step starts only once the steps it waits on are done', async () => {
    const { tools } = openJob();
    await startPlan(tools);

    const out = await tools.jobUpdate!({ step: 'reviewer', status: 'running' });

    expect(out.summary).toBe('reviewer not moved');
    expect(out.text).toBe('Step reviewer waits on builder-1.');
  });

  it('delivers the job once every step is done and handed back what it listed', async () => {
    const { job, tools } = openJob();
    await startPlan(
      tools,
      plan({
        steps: [
          { id: 'builder-1', role: 'builder', title: 'Build', deliverables: ['pr'] },
          { id: 'reviewer', role: 'reviewer', title: 'Review', after: ['builder-1'] }
        ]
      })
    );
    for (const step of ['builder-1', 'reviewer']) {
      await tools.jobUpdate!({ step, status: 'running' });
      await tools.jobUpdate!({ step, status: 'done', note: `${step} finished` });
    }
    expect(state(job.id)).toBe('running');

    sql(
      `INSERT INTO results (job_id, step_id, kind, label, listed, title, ref, delivered_at)
       VALUES (?, 'builder-1', 'pr', 'Branch and PR', 1, 'PR', 'pr1', 1)`,
      job.id
    );
    service.jobs.afterStepChange(job.id);

    expect(state(job.id)).toBe('delivered');
    expect(service.jobs.detail(job.id)?.log.map((l) => l.text)).toContain('reviewer finished');
  });

  it('finishing a step withdraws its open questions', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.askClient({ question: 'Blue or teal?', options: YES_NO, step: 'builder-1' });

    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });

    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    expect(question).toMatchObject({ status: 'withdrawn', withdrawnReason: 'step finished' });
  });

  it('delivering a job withdraws its questions still open', async () => {
    const { job, tools } = openJob();
    await startPlan(tools, plan({ steps: [PLAN.steps[0]] }));
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.askClient({ question: 'Can you trust the folder?', options: YES_NO });

    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });

    expect(state(job.id)).toBe('delivered');
    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    expect(question).toMatchObject({ status: 'withdrawn', withdrawnReason: 'the job delivered' });
  });

  it('a delivered job takes a follow-up step', async () => {
    const { job, tools } = openJob();
    await startPlan(tools, plan({ steps: [PLAN.steps[0]] }));
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });
    expect(state(job.id)).toBe('delivered');

    await startPlan(
      tools,
      plan({ steps: [PLAN.steps[0], { ...PLAN.steps[1], after: ['builder-1'] }] })
    );
    const out = await tools.jobUpdate!({ step: 'reviewer', status: 'running' });

    expect(out.text).toContain('is running');
    expect(state(job.id)).toBe('running');
  });
});

describe('the client hold', () => {
  it('holds a job while every step left waits on a question, and lets go on the answer', async () => {
    const { job, tools } = openJob();
    await startPlan(tools, plan({ steps: [PLAN.steps[0]] }));
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });

    await tools.askClient({ question: 'Blue or teal?', options: YES_NO, step: 'builder-1' });
    expect(service.store.getJob(job.id)?.holds).toEqual(['client']);

    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    service.answer({ id: question.id, option: 0 });
    expect(service.store.getJob(job.id)?.holds).toEqual([]);
  });

  it('refuses a question about a step that is not in the plan', async () => {
    const { tools } = openJob();
    await startPlan(tools);
    await expect(
      tools.askClient({ question: 'Ship it?', options: YES_NO, step: 'deployer' })
    ).rejects.toThrow('Step deployer is not in the plan.');
  });
});

describe('the snapshot note', () => {
  it('lists the plan the job runs, with step status', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });

    const note = admiralSnapshotNote(service.store, { repoId: REPO.repoId, jobId: job.id });

    expect(note).toContain(
      'Plan v1 in force (feature), budget $10, spent $0.00, 10% of the weekly Claude limit, about 0% used, starting from fleet at aaaaaaaaaaaa (default branch tip). Steps:'
    );
    expect(note).toContain('- builder-1 (builder): running. Build the toggle');
    expect(note).toContain('- reviewer (reviewer, after builder-1): pending.');
  });
});

describe('the raise-or-stop card', () => {
  const budgetCard = (jobId: number) =>
    service.store
      .listQuestions(REPO.repoId, { jobId, statuses: ['open'] })
      .find((q) => q.kind === 'budget');

  it('keeps a job going past its own budget', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    service.spend.admiralTurn(job.id, 13);
    expect(budgetCard(job.id)).toBeUndefined();
    expect(service.store.getJob(job.id)?.holds).toEqual([]);
  });

  it('holds a job at the monthly cap, and a raised cap lets it go on', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    service.spend.admiralTurn(job.id, 100);
    const card = budgetCard(job.id);
    expect(card?.options.map((o) => o.label)).toEqual(['Raise the cap to $150.00', 'Stop the job']);
    expect(service.store.getJob(job.id)?.holds).toEqual(['budget']);

    service.answer({ id: card!.id, option: 0 });

    expect(service.store.getJob(job.id)?.holds).toEqual([]);
    expect(wakeupText(job.id)).toContain('The client raised the monthly cap to $150.00');
  });

  it('cancels the job when the client stops it', async () => {
    const { job, tools } = openJob();
    await startPlan(tools);
    service.spend.admiralTurn(job.id, 100);
    service.answer({ id: budgetCard(job.id)!.id, option: 1 });
    await service.cleanup.start(job.id);
    expect(state(job.id)).toBe('cancelled');
  });

  it('cannot approve a plan budget over the monthly cap or below what was spent', async () => {
    const { job, tools } = openJob();
    await expect(propose(tools, plan({ budget: { usd: 500 } }))).rejects.toThrow(
      'monthly cap of $100.00'
    );
    await startPlan(tools);
    service.spend.admiralTurn(job.id, 4);
    await expect(propose(tools, plan({ budget: { usd: 3 } }))).rejects.toThrow('$4.00');
  });
});
