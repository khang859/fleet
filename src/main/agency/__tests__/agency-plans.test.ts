import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENCY_SETTINGS, type AgencyJob } from '../../../shared/agency';
import type { AgentAgencyCapability } from '../../../shared/agency-tools';
import { PlanSchema, type PlanInput } from '../../../shared/agency-plan';
import { AgencyService } from '../index';
import { createAgencyCapability } from '../tools';
import { admiralSnapshotNote } from '../admiral/snapshot-note';
import { canStartStep } from '../jobs/start-gate';
import { REPO, YES_NO } from './fixture';

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

function openJob(): { job: AgencyJob; tools: AgentAgencyCapability } {
  const job = service.openJob({
    repoId: REPO.repoId,
    title: 'Dark mode',
    brief: 'Add dark mode, please',
    budgetUsd: null
  });
  return {
    job,
    tools: createAgencyCapability(service, { repoId: REPO.repoId, jobId: job.id }, settings)
  };
}

/** Propose `p` with the tool and return the version id its row points at. */
async function propose(tools: AgentAgencyCapability, p = plan()): Promise<number> {
  const out = await tools.jobPlan!(p);
  const id = /plan#(\d+)/.exec(out.summary)?.[1];
  if (id === undefined) throw new Error(out.text);
  return Number(id);
}

async function approve(tools: AgentAgencyCapability, p = plan()): Promise<number> {
  const id = await propose(tools, p);
  const result = await service.jobs.decide({ planVersionId: id, action: 'approve' });
  if (!result.ok) throw new Error(result.reason);
  return id;
}

const state = (jobId: number): string | undefined => service.store.getJob(jobId)?.state;
const steps = (jobId: number): Record<string, string> =>
  Object.fromEntries(service.store.plans.steps(jobId).map((s) => [s.id, s.status]));
const wakeupText = (jobId: number): string =>
  service.pullWakeups({ repoId: REPO.repoId, jobId }).text ?? '';

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

  it('puts v1 up for the client, and nothing may start before approval', async () => {
    const { job, tools } = openJob();

    const out = await tools.jobPlan!(plan());

    expect(out.summary).toMatch(/^proposed plan v1 plan#\d+$/);
    expect(out.text).toContain('Nothing starts until they approve');
    expect(state(job.id)).toBe('planned');
    expect(service.store.getJob(job.id)?.pendingPlan).toMatchObject({ version: 1 });
    expect(service.store.plans.steps(job.id)).toEqual([]);
    const verdict = canStartStep({
      job: service.store.getJob(job.id)!,
      plan: service.jobs.approvedPlan(job.id),
      steps: [],
      stepId: 'builder-1'
    });
    expect(verdict.ok).toBe(false);
    const update = await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    expect(update.text).toContain('no approved plan');
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

describe('plan decisions', () => {
  it('approving starts the job, lays out the steps and wakes the Admiral', async () => {
    const { job, tools } = openJob();
    await approve(tools);

    expect(state(job.id)).toBe('running');
    expect(service.store.getJob(job.id)).toMatchObject({ approvedVersion: 1, budgetUsd: 10 });
    expect(steps(job.id)).toEqual({ 'builder-1': 'pending', reviewer: 'pending' });
    expect(wakeupText(job.id)).toContain('Client approved plan v1');
  });

  it('refuses an old card once a newer version is up, and names the newest', async () => {
    const { job, tools } = openJob();
    const v1 = await propose(tools);
    await propose(tools, plan({ summary: 'Add dark mode everywhere.' }));

    const result = await service.jobs.decide({ planVersionId: v1, action: 'approve' });

    expect(result).toEqual({ ok: false, reason: 'Plan v1 was replaced by v2.', newestVersion: 2 });
    expect(service.store.plans.version(v1)?.status).toBe('replaced');
    expect(state(job.id)).toBe('planned');
  });

  it('rejecting the first plan sends the job back to briefing with the note', async () => {
    const { job, tools } = openJob();
    const v1 = await propose(tools);

    const result = await service.jobs.decide({
      planVersionId: v1,
      action: 'reject',
      note: 'Skip the review step'
    });

    expect(result.ok).toBe(true);
    expect(state(job.id)).toBe('briefing');
    expect(service.store.plans.version(v1)).toMatchObject({
      status: 'rejected',
      decisionNote: 'Skip the review step'
    });
    const text = wakeupText(job.id);
    expect(text).toContain('Client rejected plan v1');
    expect(text).toContain('The client wrote: Skip the review step');
  });

  it("an edit is the client's own version, waiting like any other", async () => {
    const { job, tools } = openJob();
    const v1 = await propose(tools);

    const result = await service.jobs.decide({
      planVersionId: v1,
      action: 'edit',
      plan: { ...PLAN, budget: { usd: 5 } }
    });

    expect(result).toEqual({ ok: true, version: 2 });
    const pending = service.store.plans.pending(job.id);
    expect(pending).toMatchObject({ version: 2, author: 'client', status: 'proposed' });
    expect(pending?.plan.budget.usd).toBe(5);
    expect(wakeupText(job.id)).toContain('Client edited plan v1 into v2');
  });
});

describe('plan changes', () => {
  it('approving a change that drops a step stops its crew and withdraws its questions', async () => {
    const { job, tools } = openJob();
    await approve(tools);
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

    const v2 = await propose(tools, plan({ steps: [PLAN.steps[0]] }));
    const detail = service.jobs.detail(job.id);
    const card = detail?.versions.find((v) => v.id === v2);
    expect(card?.diff).toEqual([{ kind: 'removed', step: 'reviewer' }]);
    expect(card?.effects?.stopCrew).toEqual([
      { crewId: crew.id, stepId: 'reviewer', label: 'reviewer' }
    ]);
    expect(card?.effects?.withdrawnQuestions).toHaveLength(1);

    await service.jobs.decide({ planVersionId: v2, action: 'approve' });
    await new Promise((r) => setImmediate(r));

    expect(steps(job.id)).toEqual({ 'builder-1': 'pending', reviewer: 'removed' });
    expect(stopped).toEqual(['pane-reviewer']);
    expect(service.store.crew.get(crew.id)?.status).toBe('ended');
    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    expect(question).toMatchObject({ status: 'withdrawn', withdrawnReason: 'step removed' });
    expect(service.store.plans.version(1)?.status).toBe('superseded');
  });

  it('swapping the role of a running step stops its crew and records the choice', async () => {
    const { job, tools } = openJob();
    await approve(tools);
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

    const swapped = plan({
      steps: [{ ...PLAN.steps[0], role: 'senior-builder' }, PLAN.steps[1]]
    });
    const v2 = await propose(tools, swapped);
    const card = service.jobs.detail(job.id)?.versions.find((v) => v.id === v2);
    expect(card?.effects?.swaps).toEqual([{ stepId: 'builder-1', fields: ['role'] }]);

    await service.jobs.decide({
      planVersionId: v2,
      action: 'approve',
      swaps: { 'builder-1': 'restart' }
    });
    await new Promise((r) => setImmediate(r));

    expect(stopped).toEqual(['pane-builder']);
    expect(wakeupText(job.id)).toContain('builder-1: start over on a new branch');
  });

  it('a done step cannot change or go', async () => {
    const { job, tools } = openJob();
    await approve(tools);
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
    await approve(tools);
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
    await approve(tools);
    sql(`INSERT INTO spend_samples (job_id, source, usd, at) VALUES (?, 'crew', 7.5, 1)`, job.id);

    const out = await tools.jobPlan!(plan({ budget: { usd: 5 } }));

    expect(out.text).toContain('cannot go below what the job already spent ($7.50)');
  });
});

describe('job_update', () => {
  it('a step starts only once the steps it waits on are done', async () => {
    const { tools } = openJob();
    await approve(tools);

    const out = await tools.jobUpdate!({ step: 'reviewer', status: 'running' });

    expect(out.summary).toBe('reviewer not moved');
    expect(out.text).toBe('Step reviewer waits on builder-1.');
  });

  it('delivers the job once every step is done and handed back what it listed', async () => {
    const { job, tools } = openJob();
    await approve(
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
    await approve(tools);
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.askClient({ question: 'Blue or teal?', options: YES_NO, step: 'builder-1' });

    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });

    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    expect(question).toMatchObject({ status: 'withdrawn', withdrawnReason: 'step finished' });
  });

  it('a delivered job takes a follow-up step', async () => {
    const { job, tools } = openJob();
    await approve(tools, plan({ steps: [PLAN.steps[0]] }));
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });
    expect(state(job.id)).toBe('delivered');

    await tools.jobPlan!(
      plan({ steps: [PLAN.steps[0], { ...PLAN.steps[1], after: ['builder-1'] }] })
    );
    const v2 = service.store.plans.pending(job.id)!;
    await service.jobs.decide({ planVersionId: v2.id, action: 'approve' });
    const out = await tools.jobUpdate!({ step: 'reviewer', status: 'running' });

    expect(out.text).toContain('is running');
    expect(state(job.id)).toBe('running');
  });
});

describe('the client hold', () => {
  it('holds a job while every step left waits on a question, and lets go on the answer', async () => {
    const { job, tools } = openJob();
    await approve(tools, plan({ steps: [PLAN.steps[0]] }));
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });

    await tools.askClient({ question: 'Blue or teal?', options: YES_NO, step: 'builder-1' });
    expect(service.store.getJob(job.id)?.holds).toEqual(['client']);

    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    service.answer({ id: question.id, option: 0 });
    expect(service.store.getJob(job.id)?.holds).toEqual([]);
  });

  it('refuses a question about a step that is not in the plan', async () => {
    const { tools } = openJob();
    await approve(tools);
    await expect(
      tools.askClient({ question: 'Ship it?', options: YES_NO, step: 'deployer' })
    ).rejects.toThrow('Step deployer is not in the plan.');
  });
});

describe('the snapshot note', () => {
  it('lists the approved plan with step status and the version waiting', async () => {
    const { job, tools } = openJob();
    await approve(tools);
    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await propose(tools, plan({ budget: { usd: 20 } }));

    const note = admiralSnapshotNote(service.store, { repoId: REPO.repoId, jobId: job.id });

    expect(note).toContain('Approved plan v1 (feature), budget $10, spent $0.00.');
    expect(note).toContain('- builder-1 (builder): running. Build the toggle');
    expect(note).toContain('- reviewer (reviewer, after builder-1): pending.');
    expect(note).toContain('Plan v2 is waiting on the client');
  });
});
