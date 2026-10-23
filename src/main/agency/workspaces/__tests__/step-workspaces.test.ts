import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { PlanInput } from '../../../../shared/agency-plan';
import type { ProjectSetup } from '../../../../shared/agency-projects';
import { JobDeliverArgs } from '../../../../shared/agency-tools';
import { startedJobIn, repoAt } from '../../__tests__/plan-helpers';
import { AgencyService } from '../../index';
import { fakeGh, git, initRepo, shopUmbrella, tempDir } from '../../projects/__tests__/git-fixture';
import { runSetup } from '../setup-run';

/**
 * Where each step of a plan works, on real repositories: fresh worktrees that
 * merge what earlier steps committed, a step that reads another's worktree,
 * and the project's setup commands run in each new workspace.
 */

// Real git runs take a second or two alone, and far longer when the whole suite runs at once.
const GIT_TIMEOUT_MS = 20_000;

let home: { dir: string; cleanup: () => void };
let service: AgencyService;

beforeEach(() => {
  home = tempDir('fleet-step-ws-');
  // Merges make commits, which need an author on a machine with no git config.
  for (const kind of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${kind}_NAME`, 'Test');
    vi.stubEnv(`GIT_${kind}_EMAIL`, 'test@example.com');
  }
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
  vi.unstubAllEnvs();
});

type Step = PlanInput['steps'][number];
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  role: 'builder',
  title: id,
  deliverables: ['branch'],
  ...over
});

async function soloRepo(
  files: Record<string, string> = { 'a.txt': 'a\n' }
): Promise<AgencyRepoRef> {
  return repoAt(service, initRepo(join(home.dir, 'solo'), files));
}

/** Commit `file` in a worktree, as a crew member finishing its step would. */
function commit(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', file);
}

/** Record that a crew member worked the step in that workspace. */
function worked(jobId: number, stepId: string, workspaceId: number): void {
  service.store.crew.insert({
    jobId,
    stepId,
    role: 'builder',
    runtime: 'claude',
    label: stepId,
    workspaceId,
    status: 'ended'
  });
}

async function saveSetup(
  repo: AgencyRepoRef,
  patch: (s: ProjectSetup) => ProjectSetup
): Promise<void> {
  const scan = await service.projects.scan(repo);
  await service.projects.saveSetup(
    { repo, setup: patch(scan.setup), imports: [] },
    { finish: true }
  );
}

describe('step workspaces', { timeout: GIT_TIMEOUT_MS }, () => {
  it('merges what side-by-side steps committed, and lets later steps read or build on it', async () => {
    const repo = await soloRepo();
    const { jobId } = await startedJobIn(service, repo, [
      step('a', { scope: 'x' }),
      step('b', { scope: 'y' }),
      step('join', { after: ['a', 'b'], workspace: { integrate: ['a', 'b'] } }),
      step('review', { after: ['join'], workspace: { of: 'join' }, deliverables: ['review'] }),
      step('qa', { after: ['review'], deliverables: ['report'] })
    ]);
    for (const [id, file] of [
      ['a', 'x.txt'],
      ['b', 'y.txt']
    ]) {
      const ws = await service.workspaces.open(jobId, id);
      commit(ws.root, file, `${id}\n`);
      worked(jobId, id, ws.id);
    }

    const join_ = await service.workspaces.open(jobId, 'join');
    expect(existsSync(join(join_.root, 'x.txt'))).toBe(true);
    expect(existsSync(join(join_.root, 'y.txt'))).toBe(true);
    worked(jobId, 'join', join_.id);

    // A review works in join's worktree: no new worktree, no new branch.
    const review = await service.workspaces.open(jobId, 'review');
    expect(review).toEqual(join_);
    worked(jobId, 'review', review.id);

    // QA after the review builds on join's branch, which the review read.
    const qa = await service.workspaces.open(jobId, 'qa');
    expect(qa.root).not.toBe(join_.root);
    expect(readFileSync(join(qa.root, 'y.txt'), 'utf8')).toBe('b\n');
    expect(git(qa.root, 'branch', '--show-current')).toBe('admiral/j1/qa-1');
  });

  it('stops at a conflict, names the files, and leaves the worktree clean', async () => {
    const repo = await soloRepo();
    const { jobId } = await startedJobIn(service, repo, [
      step('a', { scope: 'x' }),
      step('b', { scope: 'y' }),
      step('join', { after: ['a', 'b'], workspace: { integrate: ['a', 'b'] } })
    ]);
    for (const id of ['a', 'b']) {
      const ws = await service.workspaces.open(jobId, id);
      commit(ws.root, 'a.txt', `${id} changed\n`);
      worked(jobId, id, ws.id);
    }
    await expect(service.workspaces.open(jobId, 'join')).rejects.toThrow(
      "b's branch admiral/j1/b-1 conflicts in solo: a.txt."
    );
    const root = join(home.dir, 'agency-home', 'jobs', '1', 'ws', 'join-1');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a changed\n');
  });

  it('hands back the branch of the member the work is in, since every member gets its name', async () => {
    const root = shopUmbrella(home.dir);
    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
    const { jobId, tools } = await startedJobIn(service, ref, step('fix'));
    const ws = await service.workspaces.open(jobId, 'fix');
    commit(ws.root, 'README.md', '# Shop!\n');
    const branch = 'admiral/j1/fix-1';
    const deliver = async (): Promise<string> =>
      (await tools.jobDeliver!(JobDeliverArgs.parse({ step: 'fix', kind: 'branch', branch }))).text;

    await deliver();
    const [card] = service.jobs.detail(jobId)!.results;
    expect(card.member).toBe('shop');
    expect(card.body).toEqual({ kind: 'branch', branch, sha: git(ws.root, 'rev-parse', 'HEAD') });

    commit(join(ws.root, 'libs', 'core'), 'package.json', '{}\n');
    expect(await deliver()).toContain(
      `${branch} has new commits in core, shop. Deliver it once for each, with member set.`
    );
  });

  it('refuses to read the worktree of a step nobody worked yet', async () => {
    const repo = await soloRepo();
    const { jobId } = await startedJobIn(service, repo, [
      step('build'),
      step('review', { after: ['build'], workspace: { of: 'build' }, deliverables: ['review'] })
    ]);
    await expect(service.workspaces.open(jobId, 'review')).rejects.toThrow(
      'build has no worktree to read yet.'
    );
  });
});

describe('setup in a new workspace', { timeout: GIT_TIMEOUT_MS }, () => {
  it('runs the setup in the worktree, and fails the workspace with the end of its output', async () => {
    const repo = await soloRepo();
    await saveSetup(repo, (s) => ({
      ...s,
      members: s.members.map((m) => ({ ...m, setupCommand: 'pwd > setup-ran.txt' }))
    }));
    const { jobId } = await startedJobIn(service, repo, step('build'));
    const ws = await service.workspaces.open(jobId, 'build');
    expect(readFileSync(join(ws.root, 'setup-ran.txt'), 'utf8').trim()).toBe(ws.root);

    await saveSetup(repo, (s) => ({
      ...s,
      members: s.members.map((m) => ({
        ...m,
        setupCommand: 'echo installing; echo boom >&2; exit 3'
      }))
    }));
    const log = join(home.dir, 'agency-home', 'jobs', '1', 'setup', 'build-2', 'solo.log');
    await expect(service.workspaces.open(jobId, 'build')).rejects.toThrow(
      `solo setup (echo installing; echo boom >&2; exit 3) exited with code 3.\ninstalling\nboom\nFull output: ${log}`
    );
  });

  it('sets up the members in member order, then the workspace, and starts the crew in its one member', async () => {
    const root = shopUmbrella(home.dir);
    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
    const order = join(home.dir, 'order.txt');
    await saveSetup(ref, (s) => ({
      ...s,
      members: s.members.map((m) => ({ ...m, setupCommand: `echo ${m.name} >> ${order}` })),
      setupCommand: `echo workspace >> ${order}`
    }));
    const { jobId } = await startedJobIn(service, ref, [
      step('api', { changes: ['api'], reads: ['core'], scope: 'api' }),
      step('web', { changes: ['web'] })
    ]);
    const api = await service.workspaces.open(jobId, 'api');
    expect(readFileSync(order, 'utf8')).toBe('core\napi\nshop\nworkspace\n');
    expect(api.cwd).toBe(api.root);

    const web = await service.workspaces.open(jobId, 'web');
    expect(web.cwd).toBe(join(web.root, 'libs', 'web'));
  });
});

describe('ports of a new workspace', { timeout: GIT_TIMEOUT_MS }, () => {
  it('gives each job its own block, sets the port variables for setup and the crew, and frees the block when the job ends', async () => {
    const repo = await soloRepo();
    await saveSetup(repo, (s) => ({
      ...s,
      members: s.members.map((m) => ({
        ...m,
        portVars: ['API_PORT', 'PORT'],
        setupCommand: 'echo "$API_PORT $PORT $FLEET_PORTS $COMPOSE_PROJECT_NAME" > ports.txt'
      }))
    }));
    const one = await startedJobIn(service, repo, step('build'));
    const two = await startedJobIn(service, repo, step('build'));
    const [a, b] = await Promise.all([
      service.workspaces.open(one.jobId, 'build'),
      service.workspaces.open(two.jobId, 'build')
    ]);

    const start = Number(a.env.API_PORT);
    expect(a.env).toEqual({
      API_PORT: String(start),
      PORT: String(start + 1),
      FLEET_PORTS: `${start}-${start + 19}`,
      COMPOSE_PROJECT_NAME: 'admiral-j1-build-1'
    });
    expect(readFileSync(join(a.root, 'ports.txt'), 'utf8')).toBe(
      `${start} ${start + 1} ${start}-${start + 19} admiral-j1-build-1\n`
    );
    expect(Math.abs(Number(b.env.API_PORT) - start)).toBeGreaterThanOrEqual(20);
    expect(b.env.COMPOSE_PROJECT_NAME).toBe('admiral-j2-build-1');
    expect(service.workspaces.folder(one.jobId, a.id)?.env).toEqual(a.env);

    expect(service.closeJob({ jobId: one.jobId, action: 'cancel' })).toEqual({ ok: true });
    await service.cleanup.start(one.jobId);
    expect(service.store.resources.heldPorts()).toEqual([
      { start: Number(b.env.API_PORT), size: 20 }
    ]);
  });
});

describe('env files of a new workspace', { timeout: GIT_TIMEOUT_MS }, () => {
  beforeEach(() => {
    // The user's own global ignore file must not decide what git ignores here.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  });

  it('copies the chosen env files before setup, mode 600, so a crew edit never reaches the user', async () => {
    const repo = await soloRepo({ 'a.txt': 'a\n', '.gitignore': '.env\n' });
    const userFile = join(repo.root, '.env');
    writeFileSync(userFile, 'API_KEY=sk_test_123456\n');
    writeFileSync(join(repo.root, '.env.test'), 'TOKEN=x\n');
    const scan = await service.projects.scan(repo);
    expect(scan.envFiles).toEqual([
      { member: 'solo', path: '.env', vars: ['API_KEY'], ignored: true },
      { member: 'solo', path: '.env.test', vars: ['TOKEN'], ignored: false }
    ]);
    await saveSetup(repo, (s) => ({
      ...s,
      members: s.members.map((m) => ({ ...m, envFiles: ['.env'], setupCommand: 'cp .env seen' }))
    }));
    const { jobId } = await startedJobIn(service, repo, step('build'));
    const ws = await service.workspaces.open(jobId, 'build');

    const copy = join(ws.root, '.env');
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(ws.root, 'seen'), 'utf8')).toBe('API_KEY=sk_test_123456\n');
    writeFileSync(copy, 'API_KEY=changed by crew\n');
    expect(readFileSync(userFile, 'utf8')).toBe('API_KEY=sk_test_123456\n');
    expect(git(ws.root, 'status', '--porcelain')).toBe('?? seen');
  });

  it('refuses an env file git does not ignore, naming it', async () => {
    const repo = await soloRepo({ 'a.txt': 'a\n', '.gitignore': '.env\n' });
    writeFileSync(join(repo.root, '.env.test'), 'TOKEN=x\n');
    await saveSetup(repo, (s) => ({
      ...s,
      members: s.members.map((m) => ({ ...m, envFiles: ['.env.test'] }))
    }));
    const { jobId } = await startedJobIn(service, repo, step('build'));
    await expect(service.workspaces.open(jobId, 'build')).rejects.toThrow(
      '.env.test is not ignored by git, so crew could commit it.'
    );
  });
});

describe('runSetup', () => {
  it('stops a command at its timeout, the whole group', async () => {
    const log = join(home.dir, 'slow.log');
    const failed = await runSetup({
      label: 'slow setup',
      command: 'echo started; sleep 30',
      cwd: home.dir,
      timeoutSec: 1,
      log
    });
    expect(failed).toBe(
      `slow setup (echo started; sleep 30) stopped after 1 s.\nstarted\nFull output: ${log}`
    );
    expect(readFileSync(log, 'utf8')).toBe('started\n');
  });
});
