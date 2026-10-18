import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanInput } from '../../../shared/agency-plan';
import { AgencyService } from '../index';
import type { CrewControl } from '../jobs';
import type { GitRun } from '../repo-identity';
import { factsGit, fakeGh, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** Fleet restarts while a job's crew are working: the job is interrupted and waits on the client. */

let dir: string;
let service: AgencyService;

const workspaceGit: GitRun = async (args, cwd) => {
  const cmd = args.join(' ');
  if (cmd.includes('status --porcelain')) return Promise.resolve(' M a.ts\n?? b.ts');
  if (cmd.startsWith('log -1')) return Promise.resolve(`abc1234 wip in ${cwd}`);
  return factsGit()(args, cwd);
};

function start(livePanes: string[] = []): void {
  const crew: CrewControl = {
    stop: async () => Promise.resolve(),
    livePanes: () => new Set(livePanes)
  };
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    git: workspaceGit,
    gh: fakeGh(),
    crew
  });
  service.ensureLobby(REPO);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-reconcile-'));
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Two builders.',
  steps: [
    { id: 'builder-1', role: 'builder', title: 'Front', deliverables: [] },
    { id: 'builder-2', role: 'builder', title: 'Back', deliverables: [] }
  ],
  budget: { usd: 10 }
};

const { openJob, approve } = planHelpers(() => service, PLAN);

/** A running job with a crew member on each step, the way the crew phase hires them. */
async function runningJob(): Promise<number> {
  const { job, tools } = openJob();
  await approve(tools);
  for (const [i, step] of ['builder-1', 'builder-2'].entries()) {
    await tools.jobUpdate!({ step, status: 'running' });
    service.store.tx(() => {
      const workspace = service.store.resources.record({
        jobId: job.id,
        kind: 'member_worktree',
        label: `${step} worktree`,
        status: 'live'
      });
      service.store.crew.insert({
        jobId: job.id,
        stepId: step,
        role: 'builder',
        runtime: 'claude',
        label: `Builder ${i + 1}`,
        paneId: `pane-${i + 1}`,
        workspaceId: workspace.id,
        status: 'working'
      });
    });
  }
  return job.id;
}

describe('startup reconcile', () => {
  it('interrupts a job whose crew panes are gone, and puts up Resume or Cancel', async () => {
    start();
    const jobId = await runningJob();
    service.close();

    start();
    await service.startup();

    expect(service.store.getJob(jobId)?.state).toBe('interrupted');
    expect(service.store.plans.steps(jobId).map((s) => s.status)).toEqual([
      'interrupted',
      'interrupted'
    ]);
    expect(service.store.crew.live(jobId)).toEqual([]);
    const card = service.snapshot(REPO.repoId).questions.find((q) => q.kind === 'resume');
    expect(card?.options.map((o) => o.label)).toEqual(['Resume', 'Cancel']);
    const wake = (await service.pullWakeups({ repoId: REPO.repoId, jobId })).text ?? '';
    expect(wake).toContain('Fleet restarted and the crew stopped');
  });

  it('leaves a job alone while its crew panes still run', async () => {
    start();
    const jobId = await runningJob();
    service.close();

    start(['pane-1', 'pane-2']);
    await service.startup();

    expect(service.store.getJob(jobId)?.state).toBe('running');
  });

  it('runs again only when the client picks Resume', async () => {
    start();
    const jobId = await runningJob();
    service.close();
    start();
    await service.startup();
    await service.pullWakeups({ repoId: REPO.repoId, jobId });
    const card = service.snapshot(REPO.repoId).questions.find((q) => q.kind === 'resume');

    service.answer({ id: card!.id, option: 0 });

    expect(service.store.getJob(jobId)?.state).toBe('running');
    const wake = (await service.pullWakeups({ repoId: REPO.repoId, jobId })).text ?? '';
    expect(wake).toContain('The client picked Resume');
  });

  it('closes and cleans up when the client picks Cancel', async () => {
    start();
    const jobId = await runningJob();
    service.close();
    start();
    await service.startup();
    const card = service.snapshot(REPO.repoId).questions.find((q) => q.kind === 'resume');

    service.answer({ id: card!.id, option: 1 });
    await service.cleanup.start(jobId);

    expect(service.store.getJob(jobId)?.state).toBe('cancelled');
  });
});
