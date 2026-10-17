import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyChanged, AgencyRepoRef } from '../../../../shared/agency';
import { STARTER_SOURCE } from '../../../../shared/agency-client-file';
import { AgencyService } from '../../index';
import { clientFilePath, setupFilePath } from '../paths';
import { fakeGh, git, initRepo, tempDir } from './git-fixture';

/** Onboarding through the service, as the renderer drives it: scan, save, share, starter. */

let tmp: { dir: string; cleanup: () => void };
let home: string;
let root: string;
let repo: AgencyRepoRef;
let emitted: AgencyChanged[];
let service: AgencyService;

beforeEach(async () => {
  tmp = tempDir('fleet-projects-svc-');
  home = join(tmp.dir, 'agency-home');
  root = initRepo(join(tmp.dir, 'shop'), {
    'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'vitest' } }),
    'package-lock.json': '{}',
    '.fleet/crew/roles/qa.md': '# QA\n',
    'src/index.ts': 'export {};\n'
  });
  emitted = [];
  service = new AgencyService({
    dbPath: join(tmp.dir, 'agency.db'),
    emit: (change) => emitted.push(change),
    hasModelKey: () => true,
    gh: fakeGh(() => null),
    agencyHome: home
  });
  const res = await service.resolveRepo(root);
  if (!res.ok) throw new Error('not a repo');
  repo = { repoId: res.repoId, root: res.root, name: res.name };
});

afterEach(() => {
  service.close();
  tmp.cleanup();
});

describe('ProjectsService', () => {
  it('saves a setup, imports what was picked, and moves the pane on only when finished', async () => {
    const scan = await service.projects.scan(repo);
    expect(scan.setup.members[0].setupCommand).toBe('npm ci');

    await service.projects.saveSetup(
      { repo, setup: scan.setup, imports: ['.fleet/crew/roles/qa.md'] },
      { finish: false }
    );
    expect(emitted).toEqual([]);
    expect(service.store.onboarding(repo.repoId).setupDoneAt).toBeNull();

    const path = await service.projects.saveSetup(
      { repo, setup: { ...scan.setup, name: 'Shop' }, imports: [] },
      { finish: true }
    );
    expect(path).toBe(setupFilePath(repo.repoId, home));
    expect(emitted).toEqual([{ repoId: repo.repoId, jobIds: [] }]);
    expect(service.store.onboarding(repo.repoId).setupDoneAt).not.toBeNull();

    const again = await service.projects.scan(repo);
    expect(again.saved).toBe(true);
    expect(again.setup.name).toBe('Shop');
  });

  it('refuses to import a file that is not one setup offers', async () => {
    const { setup } = await service.projects.scan(repo);
    await expect(
      service.projects.saveSetup({ repo, setup, imports: ['src/index.ts'] }, { finish: true })
    ).rejects.toThrow(/not a file setup can import/);
    expect(existsSync(setupFilePath(repo.repoId, home))).toBe(false);
  });

  it('shares with the team without committing or finishing setup', async () => {
    const { setup } = await service.projects.scan(repo);
    const written = await service.projects.share({
      repo,
      setup,
      imports: ['.fleet/crew/roles/qa.md']
    });
    expect(written).toEqual(['.fleet/fleet.agency.toml', '.fleet/crew/roles/qa.md']);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe('?? .fleet/fleet.agency.toml');
    expect(service.store.onboarding(repo.repoId).setupDoneAt).toBeNull();
  });

  it('writes the starter answers to the client file and marks the questions done', async () => {
    const text = await service.projects.finishStarter({
      repo,
      lines: [
        { text: 'Open PRs as drafts.', source: STARTER_SOURCE },
        { text: 'Use pnpm.', source: 'CLAUDE.md' }
      ]
    });
    expect(readFileSync(clientFilePath(repo.repoId, home), 'utf8')).toBe(text);
    expect(text).toMatch(
      /^# shop\n- Open PRs as drafts\. \(from starter questions, \d{4}-\d\d-\d\d\)\n/
    );
    expect(service.store.onboarding(repo.repoId).starterDoneAt).not.toBeNull();
    expect(emitted).toEqual([{ repoId: repo.repoId, jobIds: [] }]);
    expect(service.clientFileForNote(repo.repoId)).toBe(text.trim());
  });
});
