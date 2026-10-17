import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanInput } from '../../../shared/agency-plan';
import { JobDeliverArgs, type AgentAgencyCapability } from '../../../shared/agency-tools';
import { AgencyService } from '../index';
import type { GhRun } from '../projects/gh';
import { resultsDir } from '../results/result-files';
import { factsGit, REPO } from './fixture';
import { planHelpers } from './plan-helpers';

/** `job_deliver`, the files it copies, and PR cards kept current, through the service. */

let dir: string;
let root: string;
let home: string;
let service: AgencyService;
const clock = { now: 1_000_000 };

const recorded = JSON.parse(
  readFileSync(join(__dirname, '../results/__tests__/fixtures/pr-654-merged.json'), 'utf8')
) as Record<string, unknown>;
const PR_URL = 'https://github.com/khang859/fleet/pull/654';

/** GitHub as the test sets it: the recorded PR, open, at whatever head and state. */
const github = { head: 'a'.repeat(40), state: 'OPEN', additions: 10, calls: 0 };
const gh: GhRun = async (args) => {
  if (args[0] !== 'pr') return Promise.resolve({ code: 0, stdout: '' });
  github.calls += 1;
  const pr = {
    ...recorded,
    headRefOid: github.head,
    state: github.state,
    additions: github.additions
  };
  return Promise.resolve({ code: 0, stdout: JSON.stringify(pr) });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-results-'));
  root = join(dir, 'repo');
  home = join(dir, 'home');
  mkdirSync(root);
  Object.assign(github, { head: 'a'.repeat(40), state: 'OPEN', additions: 10, calls: 0 });
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    now: () => clock.now,
    git: factsGit({ remote: 'git@github.com:khang859/fleet.git' }),
    gh,
    agencyHome: home
  });
  service.ensureLobby({ ...REPO, root });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Ship it with notes.',
  steps: [
    { id: 'builder-1', role: 'builder', title: 'Build it', deliverables: ['pr'] },
    {
      id: 'writer-1',
      role: 'writer',
      title: 'Write it up',
      deliverables: [{ kind: 'doc', label: 'Release notes' }]
    }
  ],
  budget: { usd: 10 }
};

const { openJob, approve } = planHelpers(() => service, PLAN);

const deliver = async (
  tools: AgentAgencyCapability,
  args: Record<string, unknown>
): Promise<{ text: string; summary: string }> => tools.jobDeliver!(JobDeliverArgs.parse(args));

async function runningJob(): Promise<{ jobId: number; tools: AgentAgencyCapability }> {
  const { job, tools } = openJob();
  await approve(tools);
  return { jobId: job.id, tools };
}

function file(folder: string, name: string, text = name): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), text);
  return join(folder, name);
}

describe('job_deliver', () => {
  it('copies a delivered file out of the worktree, so close never loses it', async () => {
    const { jobId, tools } = await runningJob();
    const worktree = join(home, 'jobs', String(jobId), 'ws', 'writer-1-1');
    const notes = file(worktree, 'notes.md', '# v2');
    service.store.resources.record({
      jobId,
      kind: 'member_worktree',
      label: 'writer-1 worktree',
      path: worktree,
      status: 'live'
    });

    const out = await deliver(tools, {
      step: 'writer-1',
      kind: 'doc',
      title: 'Notes for v2',
      paths: [notes]
    });
    expect(out.summary).toMatch(/^delivered doc result#\d+$/);

    // The worktree goes, with everything in it.
    rmSync(worktree, { recursive: true });
    service.closeJob({ jobId, action: 'cancel' });
    await service.cleanup.start(jobId);

    const [result] = service.jobs.detail(jobId)!.results;
    expect(result).toMatchObject({ label: 'Release notes', listed: true, title: 'Notes for v2' });
    const copy = result.body.kind === 'doc' ? result.body.files[0] : null;
    expect(copy).toMatchObject({ name: 'notes.md', type: 'text/markdown', size: 4 });
    expect(copy!.path.startsWith(resultsDir(home, jobId))).toBe(true);
    expect(readFileSync(copy!.path, 'utf8')).toBe('# v2');
    expect(existsSync(worktree)).toBe(false);
  });

  it('shows a result the step did not list as an extra, and the step is not blocked', async () => {
    const { jobId, tools } = await runningJob();
    const sheet = file(root, 'pricing.xlsx');

    const out = await deliver(tools, {
      step: 'writer-1',
      kind: 'file',
      title: 'Pricing',
      paths: [sheet]
    });

    expect(out.text).toContain('shows as an extra');
    expect(service.jobs.detail(jobId)!.results[0]).toMatchObject({
      kind: 'file',
      label: 'File',
      listed: false
    });
    expect(service.store.plans.step(jobId, 'writer-1')?.status).toBe('pending');
  });

  it('delivers the job once every step is done and handed back what it listed', async () => {
    const { jobId, tools } = await runningJob();
    for (const step of ['builder-1', 'writer-1']) {
      await tools.jobUpdate!({ step, status: 'running' });
      await tools.jobUpdate!({ step, status: 'done' });
    }
    await deliver(tools, {
      step: 'writer-1',
      kind: 'doc',
      title: 'Notes',
      paths: [file(root, 'notes.md')]
    });
    expect(service.store.getJob(jobId)?.state).toBe('running');

    await deliver(tools, { step: 'builder-1', kind: 'pr', url: PR_URL });

    expect(service.store.getJob(jobId)?.state).toBe('delivered');
    const pr = service.jobs.detail(jobId)!.results[1];
    expect(pr).toMatchObject({ kind: 'pr', label: 'Branch and PR', title: recorded.title });
  });

  it('takes copy, links and local branches', async () => {
    const { jobId, tools } = await runningJob();
    await deliver(tools, {
      step: 'writer-1',
      kind: 'copy',
      title: 'Tweet',
      text: 'Dark mode is here.'
    });
    await deliver(tools, {
      step: 'writer-1',
      kind: 'link',
      title: 'Docs',
      url: 'https://example.com/d'
    });
    await deliver(tools, { step: 'builder-1', kind: 'branch', branch: 'feat/dark-mode' });

    expect(service.jobs.detail(jobId)!.results.map((r) => r.body)).toEqual([
      { kind: 'copy', text: 'Dark mode is here.' },
      { kind: 'link', url: 'https://example.com/d' },
      { kind: 'branch', branch: 'feat/dark-mode', sha: 'a'.repeat(40) }
    ]);
  });

  it.each<[string, () => Record<string, unknown>, string]>([
    ['a file outside the project', () => ({ paths: ['/etc/hosts'] }), 'outside the project'],
    ['an env file', () => ({ paths: [file(root, '.env.local')] }), 'is an env file'],
    ['a missing file', () => ({ paths: [join(root, 'gone.md')] }), 'does not exist'],
    ['a folder', () => ({ paths: [root] }), 'is not a file'],
    ['a relative path', () => ({ paths: ['notes.md'] }), 'not an absolute path']
  ])('refuses %s', async (_, args, reason) => {
    const { jobId, tools } = await runningJob();
    const out = await deliver(tools, { step: 'writer-1', kind: 'doc', title: 'Notes', ...args() });
    expect(out.summary).toBe('not delivered');
    expect(out.text).toContain(reason);
    expect(service.jobs.detail(jobId)!.results).toEqual([]);
  });

  it('refuses a PR of another repository, and a step that is not in the plan', async () => {
    const { tools } = await runningJob();
    const other = await deliver(tools, {
      step: 'builder-1',
      kind: 'pr',
      url: 'https://github.com/acme/other/pull/1'
    });
    expect(other.text).toContain("not this project's GitHub repository");
    const stranger = await deliver(tools, { step: 'qa-1', kind: 'link', title: 'x', url: PR_URL });
    expect(stranger.text).toContain('Step qa-1 is not in the approved plan');
  });

  it('asks for what each kind is handed back as', () => {
    expect(JobDeliverArgs.safeParse({ step: 'b', kind: 'pr' }).success).toBe(false);
    expect(JobDeliverArgs.safeParse({ step: 'b', kind: 'doc', paths: ['/a'] }).success).toBe(false);
    expect(
      JobDeliverArgs.safeParse({ step: 'b', kind: 'link', title: 'x', url: 'file:///etc' }).success
    ).toBe(false);
    expect(JobDeliverArgs.safeParse({ step: 'b', kind: 'branch', branch: '-D' }).success).toBe(
      false
    );
  });
});

describe('PR result cards', () => {
  it('refresh at most once a minute when shown, and mark a force-push', async () => {
    const { jobId, tools } = await runningJob();
    await deliver(tools, { step: 'builder-1', kind: 'pr', url: PR_URL });
    const calls = github.calls;

    Object.assign(github, { head: 'b'.repeat(40), additions: 42 });
    await service.results.refreshPrs(jobId);
    const [pr] = service.jobs.detail(jobId)!.results;
    expect(pr.changedAfterDelivery).toBe(true);
    expect(pr.body.kind === 'pr' && pr.body.pr.additions).toBe(42);

    await service.results.refreshPrs(jobId);
    expect(github.calls).toBe(calls + 1);
    clock.now += 60_000;
    await service.results.refreshPrs(jobId);
    expect(github.calls).toBe(calls + 2);
  });

  it('say in the close summary when a delivered PR was closed without merging', async () => {
    const { jobId, tools } = await runningJob();
    await deliver(tools, { step: 'builder-1', kind: 'pr', url: PR_URL });
    github.state = 'CLOSED';

    service.closeJob({ jobId, action: 'cancel' });
    await service.cleanup.start(jobId);

    const summary = service.jobs.detail(jobId)!.log.findLast((l) => l.kind === 'close_summary');
    expect(summary?.text).toBe('Nothing to clean up. PR #654 was closed without merging.');
  });
});

describe('opening a delivered file', () => {
  it('opens only a copy in the job results folder', async () => {
    const { jobId, tools } = await runningJob();
    await deliver(tools, {
      step: 'writer-1',
      kind: 'doc',
      title: 'N',
      paths: [file(root, 'n.md')]
    });
    await deliver(tools, { step: 'builder-1', kind: 'pr', url: PR_URL });
    const [doc, pr] = service.jobs.detail(jobId)!.results;

    expect(service.results.filePath({ resultId: doc.id, file: 0 })).toMatch(
      new RegExp(`^${resultsDir(home, jobId)}/writer-1-\\w+/n\\.md$`)
    );
    expect(service.results.filePath({ resultId: doc.id, file: 1 })).toBeNull();
    expect(service.results.filePath({ resultId: pr.id, file: 0 })).toBeNull();
  });
});
