import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanInput } from '../../../shared/agency-plan';
import type { ResourceKind } from '../../../shared/agency-jobs';
import type { CleanerResult, ResourceCleaner } from '../cleanup/cleanup-runner';
import { AgencyService, type AgencyServiceDeps } from '../index';
import type { CrewControl } from '../jobs';
import { factsGit, fakeGh, moveJob, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** Cancel, accept and the cleanup runner behind them, through the service. */

let dir: string;
let service: AgencyService;

const stopped: string[] = [];
const crew: CrewControl = {
  stop: async (paneId) => {
    stopped.push(paneId);
    return Promise.resolve();
  },
  livePanes: () => new Set()
};

/** A cleaner that answers from a list, then keeps answering with the last one. */
function scripted(...results: Array<CleanerResult | Error>): ResourceCleaner & { calls: number } {
  const fn = Object.assign(
    async () => {
      const next = results[Math.min(fn.calls, results.length - 1)];
      fn.calls += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    { calls: 0 }
  );
  return fn;
}

function start(
  cleaners: Partial<Record<ResourceKind, ResourceCleaner>> = {},
  deps: Partial<AgencyServiceDeps> = {}
): void {
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    git: factsGit(),
    gh: fakeGh(),
    crew,
    cleaners,
    ...deps
  });
  service.ensureLobby(REPO);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-cleanup-'));
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
  stopped.length = 0;
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode.',
  steps: [{ id: 'builder-1', role: 'builder', title: 'Build it', deliverables: [] }],
  budget: { usd: 10 }
};

const { openJob, approve } = planHelpers(() => service, PLAN);

const worktree = (jobId: number, label = 'builder-1 worktree'): number =>
  service.store.resources.record({
    jobId,
    kind: 'member_worktree',
    label,
    member: 'fleet',
    path: `/tmp/wt/${label}`,
    branch: `admiral/${jobId}/builder-1-1`,
    status: 'live'
  }).id;

const lastLog = (jobId: number): string | undefined =>
  service.jobs.detail(jobId)?.log.findLast((l) => l.kind === 'close_summary')?.text;

describe('cancel and accept', () => {
  it('cancels a job with nothing to clean, and ends it cancelled', async () => {
    start();
    const { job } = openJob();

    expect(service.closeJob({ jobId: job.id, action: 'cancel' })).toEqual({ ok: true });
    await service.cleanup.start(job.id);

    expect(service.store.getJob(job.id)?.state).toBe('cancelled');
    expect(lastLog(job.id)).toBe('Nothing to clean up.');
  });

  it('accepts a delivered job, and refuses to accept one still running', async () => {
    start({ member_worktree: scripted({ status: 'cleaned' }) });
    const { job, tools } = openJob();
    await approve(tools);
    worktree(job.id);

    const early = service.closeJob({ jobId: job.id, action: 'accept' });
    expect(early.ok).toBe(false);

    await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await tools.jobUpdate!({ step: 'builder-1', status: 'done' });
    expect(service.store.getJob(job.id)?.state).toBe('delivered');
    service.closeJob({ jobId: job.id, action: 'accept' });
    await service.cleanup.start(job.id);

    expect(service.store.getJob(job.id)?.state).toBe('closed');
    expect(lastLog(job.id)).toBe('Cleaned up 1 workspace.');
  });

  it('joins a second close, keeping the end the first one asked for', async () => {
    const cleaner = scripted({ status: 'cleaned' });
    start({ member_worktree: cleaner });
    const { job } = openJob();
    moveJob(service.store, job.id, 'delivered');
    worktree(job.id);

    service.closeJob({ jobId: job.id, action: 'cancel' });
    expect(service.closeJob({ jobId: job.id, action: 'accept' })).toEqual({ ok: true });
    await service.cleanup.start(job.id);

    expect(cleaner.calls).toBe(1);
    expect(service.store.getJob(job.id)?.state).toBe('cancelled');
  });

  it('stops the crew first, then the worktrees', async () => {
    const order: string[] = [];
    start({
      member_worktree: async () => {
        order.push(`worktree, stopped ${stopped.length}`);
        return Promise.resolve({ status: 'cleaned' });
      }
    });
    const { job } = openJob();
    moveJob(service.store, job.id, 'running');
    worktree(job.id);
    service.store.crew.insert({
      jobId: job.id,
      stepId: 'builder-1',
      role: 'builder',
      runtime: 'claude',
      label: 'Builder 1',
      paneId: 'pane-1',
      status: 'working'
    });

    service.closeJob({ jobId: job.id, action: 'cancel' });
    await service.cleanup.start(job.id);

    expect(stopped).toEqual(['pane-1']);
    expect(order).toEqual(['worktree, stopped 1']);
    expect(service.store.crew.live(job.id)).toEqual([]);
  });

  it('lets a job queued behind a cancelled one start', async () => {
    start();
    const first = openJob('First');
    await approve(first.tools);
    const second = openJob('Second');
    await approve(second.tools, { ...PLAN, queueBehind: first.job.id });
    await second.tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    expect(service.store.plans.step(second.job.id, 'builder-1')?.status).toBe('queued');

    service.closeJob({ jobId: first.job.id, action: 'cancel' });

    expect(service.store.plans.step(second.job.id, 'builder-1')?.status).toBe('pending');
  });
});

describe('leftovers', () => {
  it('keeps a worktree with work in it, and lists it with the reason', async () => {
    start({ member_worktree: scripted({ status: 'kept', reason: '3 untracked files' }) });
    const { job } = openJob();
    const id = worktree(job.id, 'Designer worktree');

    service.closeJob({ jobId: job.id, action: 'cancel' });
    await service.cleanup.start(job.id);

    expect(service.store.getJob(job.id)?.state).toBe('cancelled');
    expect(lastLog(job.id)).toBe('Kept Designer worktree: 3 untracked files.');
    expect(service.snapshot(REPO.repoId).leftovers).toEqual([
      {
        id,
        jobId: job.id,
        kind: 'member_worktree',
        label: 'Designer worktree',
        path: '/tmp/wt/Designer worktree',
        status: 'kept',
        detail: '3 untracked files'
      }
    ]);
  });

  it('lists a failed step with Retry until it is cleaned, and Dismiss drops it', async () => {
    const down = new Error('docker is not running');
    const compose = scripted(down, down, { status: 'cleaned' });
    start({ compose_project: compose });
    const { job } = openJob();
    const a = service.store.resources.record({
      jobId: job.id,
      kind: 'compose_project',
      label: 'Compose project',
      status: 'live'
    }).id;
    const b = service.store.resources.record({
      jobId: job.id,
      kind: 'compose_project',
      label: 'Second compose project',
      status: 'live'
    }).id;

    service.closeJob({ jobId: job.id, action: 'cancel' });
    await service.cleanup.start(job.id);

    expect(lastLog(job.id)).toContain('Could not clean Compose project: docker is not running.');
    expect(lastLog(job.id)).toContain('Retry them in Leftovers.');
    expect(service.snapshot(REPO.repoId).leftovers.map((l) => [l.id, l.status])).toEqual([
      [a, 'failed'],
      [b, 'failed']
    ]);

    await service.leftover({ resourceId: a, action: 'retry' });
    await service.leftover({ resourceId: b, action: 'dismiss' });

    expect(service.snapshot(REPO.repoId).leftovers).toEqual([]);
    expect(service.store.resources.get(a)?.status).toBe('cleaned');
    expect(service.store.resources.get(b)?.status).toBe('dismissed');
  });

  it('retries failed steps only while online, and stops after five tries', async () => {
    const online = { now: false };
    const compose = scripted(new Error('offline'));
    start({ compose_project: compose }, { isOnline: () => online.now });
    const { job } = openJob();
    const id = service.store.resources.record({
      jobId: job.id,
      kind: 'compose_project',
      label: 'Compose project',
      status: 'live'
    }).id;
    service.closeJob({ jobId: job.id, action: 'cancel' });
    await service.cleanup.start(job.id);

    await service.cleanup.retryFailedIfOnline();
    expect(compose.calls).toBe(1);

    online.now = true;
    for (let i = 0; i < 6; i++) await service.cleanup.retryFailedIfOnline();

    expect(compose.calls).toBe(5);
    expect(service.store.resources.get(id)?.attempts).toBe(5);
  });

  it('retries on a timer', async () => {
    vi.useFakeTimers();
    try {
      const compose = scripted(new Error('offline'), { status: 'cleaned' });
      start({ compose_project: compose });
      const { job } = openJob();
      service.store.resources.record({
        jobId: job.id,
        kind: 'compose_project',
        label: 'Compose project',
        status: 'live'
      });
      service.closeJob({ jobId: job.id, action: 'cancel' });
      await service.cleanup.start(job.id);

      service.cleanup.startRetrying(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(compose.calls).toBe(2);
      expect(service.snapshot(REPO.repoId).leftovers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a cleanup cut short', () => {
  it('starts again at the next launch and ends the job', async () => {
    start();
    const { job } = openJob();
    moveJob(service.store, job.id, 'running');
    // Quit after the close was recorded, before cleanup ran.
    service.store.beginClose(job.id, { type: 'cancel' }, 'test');
    service.store.resources.record({
      jobId: job.id,
      kind: 'member_worktree',
      label: 'builder-1 worktree',
      status: 'planned'
    });
    service.close();

    const cleaner = scripted({ status: 'cleaned' });
    start({ member_worktree: cleaner });
    await service.startup();

    expect(cleaner.calls).toBe(1);
    expect(service.store.getJob(job.id)?.state).toBe('cancelled');
  });
});
