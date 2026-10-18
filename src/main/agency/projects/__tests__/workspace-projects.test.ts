import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { ProjectFolder, ProjectSetup } from '../../../../shared/agency-projects';
import { AgencyService } from '../../index';
import { repoAt } from '../../__tests__/plan-helpers';
import { detectWorkspace, parseGitmodules } from '../workspace-detect';
import { fakeGh, git, initRepo, shopUmbrella, tempDir, workFolder } from './git-fixture';

/**
 * Workspace projects on real repositories: an umbrella with three submodules
 * whose packages depend on each other, and a plain folder of two repositories.
 */

let home: { dir: string; cleanup: () => void };
let service: AgencyService;

beforeEach(() => {
  home = tempDir('fleet-workspace-');
  service = new AgencyService({
    dbPath: join(home.dir, 'agency.db'),
    emit: () => {},
    hasModelKey: () => true,
    gh: fakeGh(() => ({ code: 1, stdout: '' })),
    agencyHome: join(home.dir, 'agency-home')
  });
});

afterEach(() => {
  service.close();
  home.cleanup();
});

const project = async (path: string): Promise<AgencyRepoRef> => repoAt(service, path);

const workspace = (folders: ProjectFolder[]): Extract<ProjectFolder, { kind: 'workspace' }> => {
  const row = folders.find((f) => f.kind === 'workspace');
  if (row?.kind !== 'workspace') throw new Error('no workspace row');
  return row;
};

describe('parseGitmodules', () => {
  it('reads each submodule with its path and URL, and skips one without a path', () => {
    const text = [
      '[submodule "web"]',
      '\tpath = libs/web',
      '\turl = ../web.git',
      '[submodule "broken"]',
      '\turl = ../broken.git',
      '[core]',
      '\tpath = not-a-submodule'
    ].join('\n');
    expect(parseGitmodules(text)).toEqual([{ name: 'web', path: 'libs/web', url: '../web.git' }]);
  });
});

// Each test builds four real repositories and scans them a few times, about
// 2.5 s alone and past the 5 s default when the whole suite runs at once.
describe('an umbrella with three submodules', { timeout: 20_000 }, () => {
  it('lists the members dependencies first and the umbrella last', async () => {
    const root = shopUmbrella(home.dir);
    const ws = await detectWorkspace(root, { identify: async (p) => service.identify(p) });
    expect(ws?.kind).toBe('submodules');
    expect(ws?.members.map((m) => [m.name, m.path, m.umbrella, m.repo !== null])).toEqual([
      ['core', 'libs/core', false, true],
      ['api', 'libs/api', false, true],
      ['web', 'libs/web', false, true],
      ['shop', '.', true, true]
    ]);
  });

  it('shows in the picker as a workspace, and from a member once chosen', async () => {
    const root = shopUmbrella(home.dir);
    const api = join(root, 'libs', 'api');
    const first = await service.projects.probeFolders([api, root]);
    // Not chosen yet: a submodule picked by itself is a repository of its own.
    expect(first.map((f) => [f.kind, f.path])).toEqual([
      ['repo', api],
      ['workspace', root]
    ]);
    const row = workspace(first);
    expect(row).toMatchObject({ projectKind: 'submodules', setupDone: false });
    expect(row.members.map((m) => [m.name, m.branch, m.leftOut])).toEqual([
      ['core', 'main', false],
      ['api', 'main', false],
      ['web', 'main', false],
      ['shop', 'main', false]
    ]);

    await service.projects.chooseWorkspace({ path: root, leftOut: [] });
    const chosen = await service.projects.probeFolders([api, root]);
    expect(chosen.map((f) => [f.kind, f.path])).toEqual([['workspace', root]]);
  });

  it('makes each member find the project once chosen, without the members left out', async () => {
    const root = shopUmbrella(home.dir);
    const api = join(root, 'libs', 'api');
    expect((await project(api)).root).toBe(api);

    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: ['web'] });
    expect(await project(api)).toEqual(ref);
    // A member left out stays a project of its own.
    expect((await project(join(root, 'libs', 'web'))).root).toBe(join(root, 'libs', 'web'));

    const row = workspace(await service.projects.probeFolders([root]));
    expect(row.members.find((m) => m.name === 'web')?.leftOut).toBe(true);

    const scan = await service.projects.scan(ref);
    expect(scan.kind).toBe('submodules');
    expect(scan.setup.members.map((m) => [m.name, m.path])).toEqual([
      ['core', 'libs/core'],
      ['api', 'libs/api'],
      ['shop', '.']
    ]);
    expect(scan.members.map((m) => m.readFrom)).toEqual(['main', 'main', 'main']);
    expect(scan.repoFiles.map((f) => f.path)).toEqual([
      'libs/core/CLAUDE.md',
      'libs/api/CLAUDE.md'
    ]);
  });

  it('refuses to leave out the umbrella, an unknown member, or every member', async () => {
    const root = shopUmbrella(home.dir);
    const choose = async (leftOut: string[]): Promise<AgencyRepoRef> =>
      service.projects.chooseWorkspace({ path: root, leftOut });
    await expect(choose(['shop'])).rejects.toThrow('umbrella');
    await expect(choose(['cart'])).rejects.toThrow('cart is not a member of shop.');
    await expect(choose(['core', 'api', 'web'])).resolves.toMatchObject({ root });
  });

  it('lists a submodule that is not checked out as missing, and checks it out', async () => {
    const root = shopUmbrella(home.dir);
    git(root, 'submodule', 'deinit', '-q', '-f', 'libs/core');
    expect(readdirSync(join(root, 'libs', 'core'))).toEqual([]);
    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });

    const before = await service.projects.scan(ref);
    expect(before.missing).toEqual([{ name: 'core', path: 'libs/core' }]);
    expect(before.setup.members.map((m) => m.name)).toEqual(['api', 'web', 'shop']);
    await expect(service.projects.checkOutMember({ repo: ref, path: 'libs/api' })).rejects.toThrow(
      'not a missing member'
    );

    await service.projects.checkOutMember({ repo: ref, path: 'libs/core' });
    const after = await service.projects.scan(ref);
    expect(after.missing).toEqual([]);
    expect(after.setup.members.map((m) => m.name)).toEqual(['core', 'api', 'web', 'shop']);
  });

  it('saves the members with their setup, and refuses one that is not a member', async () => {
    const root = shopUmbrella(home.dir);
    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
    const scan = await service.projects.scan(ref);
    const setup: ProjectSetup = {
      ...scan.setup,
      members: scan.setup.members.map((m) => ({ ...m, defaultBranch: 'main' }))
    };
    await service.projects.saveSetup({ repo: ref, setup, imports: [] }, { finish: true });
    const saved = service.store.projects.byId(ref.repoId);
    expect(saved?.members.map((m) => [m.name, m.defaultBranch])).toEqual([
      ['core', 'main'],
      ['api', 'main'],
      ['web', 'main'],
      ['shop', 'main']
    ]);
    expect((await service.projects.scan(ref)).saved).toBe(true);

    const stranger = { ...setup, members: [{ ...setup.members[0], name: 'cart' }] };
    await expect(
      service.projects.saveSetup({ repo: ref, setup: stranger, imports: [] }, { finish: false })
    ).rejects.toThrow('cart is not a member of shop.');
  });
});

describe('a folder of two repositories', () => {
  function folder(): string {
    const root = workFolder(home.dir);
    initRepo(join(root, '.hidden'), { 'x.md': 'x' });
    mkdirSync(join(root, 'notes'));
    return root;
  }

  it('is a workspace of its child repositories, in member order', async () => {
    const root = folder();
    const row = workspace(await service.projects.probeFolders([root]));
    expect(row).toMatchObject({ path: root, projectKind: 'folder', project: { name: 'work' } });
    expect(row.members.map((m) => [m.name, m.path, m.umbrella])).toEqual([
      ['lib', 'lib', false],
      ['app', 'app', false]
    ]);
  });

  it('opens as one project from the folder or a member once chosen', async () => {
    const root = folder();
    expect((await service.resolveRepo(root)).ok).toBe(false);
    const ref = await service.projects.chooseWorkspace({ path: root, leftOut: [] });
    expect(ref).toMatchObject({ root, name: 'work' });
    expect(await project(root)).toEqual(ref);
    expect(await project(join(root, 'app'))).toEqual(ref);
    expect(await project(join(root, 'notes'))).toEqual(ref);

    const scan = await service.projects.scan(ref);
    expect(scan.kind).toBe('folder');
    expect(scan.setup.members.map((m) => [m.name, m.path])).toEqual([
      ['lib', 'lib'],
      ['app', 'app']
    ]);
    expect(scan.teamSetup).toBeNull();
  });
});
