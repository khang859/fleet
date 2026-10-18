import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { PlanSchema, type PlanInput, type PlanStep } from '../../../../shared/agency-plan';
import { approvedJobIn } from '../../__tests__/plan-helpers';
import { AgencyService } from '../../index';
import {
  fakeGh,
  git,
  initRepo,
  shopUmbrella,
  tempDir,
  workFolder
} from '../../projects/__tests__/git-fixture';
import { workspaceLayout, type JobWorkspace } from '../job-workspace';

/**
 * Job workspaces on real repositories: a plan is approved with real git, so
 * each member's base is pinned from its own checkout, then a step's workspace
 * is made and cleaned up the way a job would.
 */

let home: { dir: string; cleanup: () => void };
let service: AgencyService;

beforeEach(() => {
  home = tempDir('fleet-job-ws-');
  service = new AgencyService({
    dbPath: join(home.dir, 'agency.db'),
    emit: () => {},
    hasModelKey: () => true,
    gh: fakeGh(() => ({ code: 0, stdout: '' })),
    agencyHome: join(home.dir, 'agency-home')
  });
});

afterEach(() => {
  service.close();
  home.cleanup();
});

const step = (changes: string[], reads: string[] = []): PlanInput['steps'][number] => ({
  id: 'builder',
  role: 'builder',
  title: 'Build it',
  changes,
  reads,
  deliverables: ['branch']
});

async function approvedJob(repo: AgencyRepoRef, s: PlanInput['steps'][number]): Promise<number> {
  return (await approvedJobIn(service, repo, s)).jobId;
}

const head = (dir: string): string => git(dir, 'rev-parse', 'HEAD');
const onBranch = (dir: string): string => git(dir, 'branch', '--show-current');
const hasBranch = (repo: string, branch: string): boolean =>
  git(repo, 'branch', '--list', branch) !== '';

const layout = (ws: JobWorkspace): Array<[string, string | null, string | null, string]> =>
  ws.parts.map((p) => [p.kind, p.member, p.branch, p.mode]);

async function cancel(jobId: number): Promise<void> {
  service.closeJob({ jobId, action: 'cancel' });
  await service.cleanup.start(jobId);
}

const resource = (jobId: number, member: string): ReturnType<typeof service.store.resources.get> =>
  service.store.resources.forJob(jobId).find((r) => r.member === member) ?? null;

describe('a job workspace in an umbrella with three submodules', { timeout: 20_000 }, () => {
  let root: string;
  let ref: AgencyRepoRef;
  const member = (name: string): string => join(root, 'libs', name);

  beforeEach(async () => {
    root = shopUmbrella(home.dir);
    ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
  });

  it('checks out the umbrella, the branch in the two members a step changes, and the one it reads', async () => {
    const jobId = await approvedJob(ref, step(['api', 'web'], ['core']));
    const bases = service.store.plans.approved(jobId)?.bases;
    expect(Object.keys(bases ?? {}).sort()).toEqual(['api', 'core', 'shop', 'web']);

    const ws = await service.workspaces.make(jobId, 'builder');
    const branch = 'admiral/j1/builder-1';
    expect(ws.branch).toBe(branch);
    expect(ws.root).toBe(join(home.dir, 'agency-home', 'jobs', '1', 'ws', 'builder-1'));
    expect(layout(ws)).toEqual([
      ['umbrella_worktree', 'shop', null, 'read'],
      ['member_worktree', 'core', null, 'read'],
      ['member_worktree', 'api', branch, 'writable'],
      ['member_worktree', 'web', branch, 'writable']
    ]);

    // Each checkout sits at its own member's pinned base, laid out like the project.
    for (const name of ['api', 'web', 'core']) {
      expect(head(join(ws.root, 'libs', name))).toBe(bases?.[name].sha);
      expect(head(join(ws.root, 'libs', name))).toBe(head(member(name)));
    }
    expect(head(ws.root)).toBe(bases?.shop.sha);
    expect(onBranch(join(ws.root, 'libs', 'api'))).toBe(branch);
    expect(onBranch(join(ws.root, 'libs', 'web'))).toBe(branch);
    expect(onBranch(join(ws.root, 'libs', 'core'))).toBe('');
    expect(onBranch(ws.root)).toBe('');
    expect(git(ws.root, 'status', '--porcelain')).toBe('');

    // The branch is made in the members the step changes, nowhere else.
    expect(hasBranch(member('api'), branch)).toBe(true);
    expect(hasBranch(member('web'), branch)).toBe(true);
    expect(hasBranch(member('core'), branch)).toBe(false);
    expect(hasBranch(root, branch)).toBe(false);

    const rows = service.store.resources.ofWorkspace(ws.id);
    expect(rows.map((r) => [r.member, r.status, r.mode, r.baseSha])).toEqual([
      ['shop', 'live', 'read', bases?.shop.sha],
      ['core', 'live', 'read', bases?.core.sha],
      ['api', 'live', 'writable', bases?.api.sha],
      ['web', 'live', 'writable', bases?.web.sha]
    ]);
  });

  it('cleans up member by member, and keeps the umbrella while a member with work stays', async () => {
    const jobId = await approvedJob(ref, step(['api', 'web'], ['core']));
    const ws = await service.workspaces.make(jobId, 'builder');
    const web = join(ws.root, 'libs', 'web');
    writeFileSync(join(web, 'page.tsx'), 'export {}\n');
    git(web, 'add', '-A');
    git(web, 'commit', '-q', '-m', 'page');

    await cancel(jobId);
    expect(resource(jobId, 'api')?.status).toBe('cleaned');
    expect(resource(jobId, 'core')?.status).toBe('cleaned');
    expect(resource(jobId, 'web')).toMatchObject({ status: 'kept' });
    expect(resource(jobId, 'shop')).toMatchObject({
      status: 'kept',
      detail: 'the web worktree in it is still there'
    });
    // A cleaned member leaves its submodule folder empty, as git leaves one not checked out.
    expect(readdirSync(join(ws.root, 'libs', 'api'))).toEqual([]);
    expect(hasBranch(member('api'), ws.branch)).toBe(false);
    expect(hasBranch(member('web'), ws.branch)).toBe(true);

    // The client drops the commit; Retry removes web, then the umbrella.
    git(web, 'reset', '-q', '--hard', 'HEAD~1');
    await service.cleanup.retry(resource(jobId, 'web')!.id);
    await service.cleanup.retry(resource(jobId, 'shop')!.id);
    expect(resource(jobId, 'web')?.status).toBe('cleaned');
    expect(resource(jobId, 'shop')?.status).toBe('cleaned');
    expect(existsSync(ws.root)).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(ws.root);
  });

  it('gives a second workspace of a step a new branch, and makes nothing when a member has it', async () => {
    const jobId = await approvedJob(ref, step(['api']));
    const first = await service.workspaces.make(jobId, 'builder');
    expect(first.branch).toBe('admiral/j1/builder-1');

    git(member('api'), 'branch', 'admiral/j1/builder-2');
    await expect(service.workspaces.make(jobId, 'builder')).rejects.toThrow(
      'api already has a branch admiral/j1/builder-2.'
    );
    expect(existsSync(join(home.dir, 'agency-home', 'jobs', '1', 'ws', 'builder-2'))).toBe(false);

    const third = await service.workspaces.make(jobId, 'builder');
    expect(third.branch).toBe('admiral/j1/builder-3');
    expect(service.store.resources.forJob(jobId)).toHaveLength(4);
  });
});

describe('a job workspace in a folder project', () => {
  it('is a folder with a worktree of each member the step needs, and goes at cleanup', async () => {
    const root = workFolder(home.dir);
    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
    const jobId = await approvedJob(ref, step(['app']));

    const ws = await service.workspaces.make(jobId, 'builder');
    expect(layout(ws)).toEqual([
      ['workspace_dir', null, null, 'writable'],
      ['member_worktree', 'app', ws.branch, 'writable']
    ]);
    expect(readdirSync(ws.root)).toEqual(['app']);
    expect(onBranch(join(ws.root, 'app'))).toBe(ws.branch);

    await cancel(jobId);
    expect(service.store.resources.forJob(jobId).map((r) => r.status)).toEqual([
      'cleaned',
      'cleaned'
    ]);
    expect(existsSync(ws.root)).toBe(false);
  });
});

describe('a job workspace in a one-repository project', () => {
  it('is one worktree on the step branch', async () => {
    const root = initRepo(join(home.dir, 'solo'), { 'a.txt': 'a' });
    const res = await service.resolveRepo(root);
    if (!res.ok) throw new Error('not a repo');
    const jobId = await approvedJob({ repoId: res.repoId, root, name: res.name }, step([]));

    const ws = await service.workspaces.make(jobId, 'builder');
    expect(layout(ws)).toEqual([['member_worktree', 'solo', ws.branch, 'writable']]);
    expect(onBranch(ws.root)).toBe(ws.branch);
    expect(head(ws.root)).toBe(head(root));
  });
});

describe('workspaceLayout', () => {
  const plan = (changes: string[], reads: string[] = []): PlanStep =>
    PlanSchema.parse({
      playbook: 'p',
      summary: 's',
      steps: [step(changes, reads)],
      budget: { usd: 1 }
    }).steps[0];
  const members = [
    { name: 'lib', path: 'lib', root: '/w/lib' },
    { name: 'app', path: 'app', root: '/w/app' }
  ];
  const at = { sha: 'a'.repeat(40), from: 'default' as const };

  it('refuses a member outside the project, and one with no base pinned', () => {
    const input = { kind: 'folder' as const, members, root: '/ws', branch: 'b' };
    expect(() =>
      workspaceLayout({ ...input, step: plan(['app'], ['cart']), bases: { app: at } })
    ).toThrow('builder names cart, which is not in this project.');
    expect(() =>
      workspaceLayout({ ...input, step: plan(['app', 'lib']), bases: { app: at } })
    ).toThrow('lib has no base commit pinned.');
  });
});
