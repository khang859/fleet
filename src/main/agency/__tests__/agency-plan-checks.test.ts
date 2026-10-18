import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewRuntime, RuntimeCheck } from '../../../shared/agency-crew';
import type { PlanInput } from '../../../shared/agency-plan';
import { AgencyService } from '../index';
import { BASE_SHA, factsGit, fakeGh, REPO, type GitFacts } from './fixture';
import { planHelpers } from './plan-helpers';

/** The pre-approval check, the base pin and the crew limit, through the service. */

const HEAD_SHA = 'b'.repeat(40);
const SHIPPED_CREW = fileURLToPath(new URL('../../../../resources/crew', import.meta.url));

let dir: string;
let service: AgencyService;

function start(
  opts: {
    git?: Partial<GitFacts>;
    gh?: 'ok' | 'signed-out';
    crewLimit?: number;
    crew?: boolean;
    runtime?: (runtime: CrewRuntime) => RuntimeCheck;
  } = {}
): void {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-checks-'));
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: () => undefined,
    hasModelKey: () => true,
    git: factsGit({ sha: (ref) => (ref === 'HEAD' ? HEAD_SHA : BASE_SHA), ...opts.git }),
    gh: fakeGh(opts.gh),
    crewLimit: opts.crewLimit === undefined ? undefined : () => opts.crewLimit!,
    agencyHome: join(dir, 'home'),
    crewDirs: opts.crew ? { bundled: SHIPPED_CREW, user: null } : undefined,
    checkRuntime: opts.runtime && (async (runtime) => Promise.resolve(opts.runtime!(runtime)))
  });
  service.ensureLobby(REPO);
}

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: PlanInput = {
  playbook: 'feature',
  summary: 'Add dark mode to the settings page.',
  steps: [
    {
      id: 'builder-1',
      role: 'builder',
      title: 'Build the toggle',
      paths: ['src/settings/'],
      deliverables: ['pr']
    }
  ],
  budget: { usd: 10 }
};

const { openJob, toolsFor, proposeOut, propose, approve } = planHelpers(() => service, PLAN);

const stepStatus = (jobId: number, step: string): string | undefined =>
  service.store.plans.step(jobId, step)?.status;

describe('deliverable check', () => {
  it('blocks a PR with no GitHub remote, tells the Admiral, and approves nothing', async () => {
    start({ git: { remote: null } });
    const { job, tools } = openJob();

    const { id, text } = await proposeOut(tools);

    expect(text).toContain('Blocking, so the client cannot approve it yet');
    expect(text).toContain('fleet has no GitHub remote. Deliver a local branch instead.');
    expect(service.store.plans.version(id)?.checks.issues[0]).toMatchObject({
      code: 'pr-unavailable',
      fix: 'use-branch'
    });
    const result = await service.jobs.decide({ planVersionId: id, action: 'approve' });
    expect(result.ok).toBe(false);
    expect(service.store.getJob(job.id)?.state).toBe('planned');
  });

  it('checks again at approval: gh signed out since the card went up', async () => {
    start();
    const { tools } = openJob();
    const id = await propose(tools);
    service.close();
    // Same database, but the GitHub CLI is now signed out.
    service = new AgencyService({
      dbPath: join(dir, 'agency.db'),
      emit: () => undefined,
      hasModelKey: () => true,
      git: factsGit(),
      gh: fakeGh('signed-out')
    });

    const result = await service.jobs.decide({ planVersionId: id, action: 'approve' });

    expect(result).toEqual({
      ok: false,
      reason:
        'builder-1 delivers a PR, but the GitHub CLI is not signed in. Deliver a local branch instead.'
    });
    expect(service.store.plans.version(id)?.checks.issues).toHaveLength(1);
  });

  it('approves the same plan with a local branch', async () => {
    start({ git: { remote: null }, gh: 'signed-out' });
    const { job, tools } = openJob();
    const local = {
      ...PLAN,
      steps: [{ ...PLAN.steps[0], deliverables: ['branch' as const] }]
    };

    await approve(tools, local);

    expect(service.store.getJob(job.id)?.state).toBe('running');
  });
});

describe('base pin', () => {
  it('pins the default branch tip at approval, or HEAD when the client picks it', async () => {
    start();
    const first = openJob('One');
    const v1 = await approve(first.tools);
    expect(service.store.plans.version(v1)?.bases).toEqual({
      fleet: { sha: BASE_SHA, from: 'default' }
    });

    const second = openJob('Two');
    const id = await propose(second.tools);
    await service.jobs.decide({
      planVersionId: id,
      action: 'approve',
      baseChoice: { fleet: 'head' }
    });
    expect(service.store.plans.version(id)?.bases).toEqual({
      fleet: { sha: HEAD_SHA, from: 'head' }
    });
  });

  it('keeps the pin through a plan change after the default branch moved', async () => {
    start();
    const { tools } = openJob();
    await approve(tools);
    service.close();
    service = new AgencyService({
      dbPath: join(dir, 'agency.db'),
      emit: () => undefined,
      hasModelKey: () => true,
      git: factsGit({ sha: () => 'c'.repeat(40) }),
      gh: fakeGh()
    });
    const job = service.store.listJobs(REPO.repoId)[0];
    const capability = toolsFor(job.id);

    const v2 = await approve(capability, { ...PLAN, budget: { usd: 20 } });

    expect(service.store.plans.version(v2)?.bases).toEqual({
      fleet: { sha: BASE_SHA, from: 'default' }
    });
    expect(service.store.plans.version(v2)?.checks.bases[0]?.pinned).toEqual({
      sha: BASE_SHA,
      from: 'default'
    });
  });

  it('warns about a dirty main checkout without blocking', async () => {
    start({ git: { status: ' M src/a.ts\n?? notes.txt' } });
    const { tools } = openJob();

    const { id, text } = await proposeOut(tools);

    expect(text).toContain('Warnings: fleet has 2 uncommitted changes in its main checkout.');
    expect((await service.jobs.decide({ planVersionId: id, action: 'approve' })).ok).toBe(true);
  });
});

describe('other running jobs', () => {
  it('lists the paths both jobs touch, and asks queue or parallel', async () => {
    start();
    const running = openJob('Settings refresh');
    await approve(running.tools);

    const next = openJob('Dark mode');
    const { id, text } = await proposeOut(next.tools, {
      ...PLAN,
      steps: [{ ...PLAN.steps[0], paths: ['src/settings/Toggle.tsx'] }]
    });

    expect(service.store.plans.version(id)?.checks.overlap).toEqual([
      {
        jobId: running.job.id,
        member: 'fleet',
        path: 'src/settings/Toggle.tsx',
        step: 'builder-1'
      }
    ]);
    expect(text).toContain('queue this job behind, or run both?');
  });

  it('leaves out jobs that finished the steps touching those paths', async () => {
    start();
    const running = openJob('Settings refresh');
    await approve(running.tools);
    await running.tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await running.tools.jobUpdate!({ step: 'builder-1', status: 'done' });

    const next = openJob('Dark mode');
    const id = await propose(next.tools);

    expect(service.store.plans.version(id)?.checks.overlap).toEqual([]);
  });
});

describe('crew limit and queue', () => {
  it('queues a step over the crew limit, and lets it go when crew stop', async () => {
    start({ crewLimit: 1 });
    const busy = openJob('Busy');
    await approve(busy.tools);
    const crew = service.store.crew.insert({
      jobId: busy.job.id,
      stepId: 'builder-1',
      role: 'builder',
      runtime: 'claude',
      label: 'Builder 1',
      status: 'working'
    });
    const { job, tools } = openJob('Waiting');
    await approve(tools);

    const out = await tools.jobUpdate!({ step: 'builder-1', status: 'running' });

    expect(out.text).toContain('Step builder-1 is queued: 1 crew members are already working');
    expect(stepStatus(job.id, 'builder-1')).toBe('queued');

    await service.jobs.stopCrew([crew.id], 'test');

    expect(stepStatus(job.id, 'builder-1')).toBe('pending');
    const wake = service.pullWakeups({ repoId: REPO.repoId, jobId: job.id }).text ?? '';
    expect(wake).toContain('Step builder-1 can start now');
    expect((await tools.jobUpdate!({ step: 'builder-1', status: 'running' })).text).toContain(
      'is running'
    );
  });

  it('queues a job behind another until that one delivers', async () => {
    start();
    const first = openJob('First');
    await approve(first.tools, { ...PLAN, steps: [{ ...PLAN.steps[0], deliverables: [] }] });
    const { job, tools } = openJob('Second');
    await approve(tools, { ...PLAN, queueBehind: first.job.id });

    const out = await tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    expect(out.text).toContain(`runs after j${first.job.id}`);
    expect(stepStatus(job.id, 'builder-1')).toBe('queued');

    await first.tools.jobUpdate!({ step: 'builder-1', status: 'running' });
    await first.tools.jobUpdate!({ step: 'builder-1', status: 'done' });

    expect(service.store.getJob(first.job.id)?.state).toBe('delivered');
    expect(stepStatus(job.id, 'builder-1')).toBe('pending');
  });
});

describe('crew roles', () => {
  const wizard: PlanInput = {
    ...PLAN,
    steps: [{ id: 'wizard-1', role: 'wizard', title: 'Cast it' }]
  };

  it('blocks a step whose role the crew does not have', async () => {
    start({ crew: true });
    const { tools } = openJob();
    const { id, text } = await proposeOut(tools, wizard);
    expect(text).toContain(
      "wizard-1 uses the role wizard, which is not one of this project's crew roles."
    );
    expect((await service.jobs.decide({ planVersionId: id, action: 'approve' })).ok).toBe(false);
  });

  it('keeps Approve off while the runtime a step runs on cannot be used', async () => {
    start({
      crew: true,
      runtime: (runtime) => ({
        runtime,
        path: '/usr/local/bin/claude',
        version: '2.0.1',
        problems: ['Claude Code 2.0.1 is older than 2.1.78, the oldest crew run on.'],
        warnings: []
      })
    });
    const { tools } = openJob();
    const { id, text } = await proposeOut(tools);
    expect(text).toContain(
      'builder-1 runs on Claude Code. Claude Code 2.0.1 is older than 2.1.78, the oldest crew run on.'
    );
    expect((await service.jobs.decide({ planVersionId: id, action: 'approve' })).ok).toBe(false);
  });

  it('asks for the trust step until a Claude Code session reports from the repository', async () => {
    start({ crew: true });
    const { tools } = openJob();
    const first = await proposeOut(tools);
    expect(service.store.plans.version(first.id)?.checks.issues).toContainEqual(
      expect.objectContaining({ code: 'claude-trust', fix: 'trust-claude', path: REPO.root })
    );

    service.noteClaudeSession(join(REPO.root, 'src'));
    const next = await proposeOut(tools);
    const codes = service.store.plans.version(next.id)?.checks.issues.map((i) => i.code);
    expect(codes).not.toContain('claude-trust');
  });

  it('keeps the approved roles, so a role edit after approval does not reach the job', async () => {
    start({ crew: true });
    const { job, tools } = openJob();
    const id = await approve(tools);
    const approved = service.store.plans.version(id)?.crew;
    expect(approved?.roles.map((r) => [r.name, r.source])).toEqual([['builder', 'bundled']]);

    const roles = join(dir, 'home', 'projects', job.repoId, 'crew', 'roles');
    mkdirSync(roles, { recursive: true });
    writeFileSync(
      join(roles, 'builder.md'),
      '---\nname: builder\ndescription: Ours.\nruntime: eva\n---\nBuild it our way.\n'
    );
    expect(service.store.plans.approved(job.id)?.crew).toEqual(approved);
    const next = (await service.crewCatalog(job.repoId)).roles.find((r) => r.name === 'builder');
    expect(next).toMatchObject({ runtime: 'eva', source: 'project' });
  });
});

describe('new roles', () => {
  const migrator = {
    name: 'data-migrator',
    description: 'Writes and checks database migrations.',
    instructions: 'You write database migrations, and run each one up and down before you commit.'
  };
  const withRole = (role = migrator): PlanInput => ({
    ...PLAN,
    steps: [{ id: 'migrate', role: role.name, title: 'Add the column' }],
    newRoles: [role]
  });
  const roleFile = (repoId: string): string =>
    join(dir, 'home', 'projects', repoId, 'crew', 'roles', 'data-migrator.md');

  it('saves a proposed role in the project crew folder only when the client approves', async () => {
    start({ crew: true });
    const { job, tools } = openJob();
    const { id, text } = await proposeOut(tools, withRole());
    expect(text).not.toContain('not one of this project');
    expect(existsSync(roleFile(job.repoId))).toBe(false);

    expect(await service.jobs.decide({ planVersionId: id, action: 'approve' })).toEqual({
      ok: true,
      version: 1
    });

    expect(readFileSync(roleFile(job.repoId), 'utf8')).toBe(
      '---\nname: data-migrator\ndescription: Writes and checks database migrations.\nruntime: claude\n---\n\nYou write database migrations, and run each one up and down before you commit.\n'
    );
    expect(existsSync(join(REPO.root, '.fleet'))).toBe(false);
    expect(service.store.plans.version(id)?.crew?.roles).toContainEqual(
      expect.objectContaining({ name: 'data-migrator', source: 'project' })
    );
    expect(service.store.plans.logTail(job.id).map((l) => l.text)).toContain(
      "Saved the role data-migrator in the project's crew"
    );

    // The next version sends the role again, unchanged, and approves as is.
    const next = await proposeOut(tools, {
      ...withRole(),
      summary: 'Add the column, then index it.'
    });
    expect(service.store.plans.version(next.id)?.checks.issues.map((i) => i.code)).not.toContain(
      'role-exists'
    );
    expect((await service.jobs.decide({ planVersionId: next.id, action: 'approve' })).ok).toBe(
      true
    );
  });

  it('blocks a new role named like a crew role that says something else', async () => {
    start({ crew: true });
    const { tools } = openJob();
    const { id, text } = await proposeOut(tools, withRole({ ...migrator, name: 'builder' }));
    expect(text).toContain(
      'The new role builder has the name of a crew role that says something else.'
    );
    expect((await service.jobs.decide({ planVersionId: id, action: 'approve' })).ok).toBe(false);
  });

  it('refuses a new role no step uses', async () => {
    start({ crew: true });
    const { tools } = openJob();
    await expect(proposeOut(tools, { ...PLAN, newRoles: [migrator] })).rejects.toThrow(
      'The new role data-migrator is not used by any step.'
    );
  });
});
