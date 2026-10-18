import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyChanged, AgencyRepoRef } from '../../../../shared/agency';
import { STARTER_SOURCE } from '../../../../shared/agency-client-file';
import { AgencyService } from '../../index';
import { clientFilePath, setupFilePath } from '../paths';
import { fakeGh, git, initRepo, tempDir, writeFiles } from './git-fixture';

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

// Each test scans and commits in a real git repository, which can take over
// the default five seconds while the whole suite runs at once.
describe('ProjectsService', { timeout: 20_000 }, () => {
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

  it('shows the remote the repository has now, not the one saved with the setup', async () => {
    const first = await service.projects.scan(repo);
    expect(first.setup.members[0].remote).toBeNull();
    await service.projects.saveSetup({ repo, setup: first.setup, imports: [] }, { finish: true });
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
    const again = await service.projects.scan(repo);
    expect(again.saved).toBe(true);
    expect(again.setup.members[0].remote).toBe('git@github.com:acme/shop.git');
  });

  it('keeps an imported crew file until the client takes the newer one from the repo', async () => {
    const qa = '.fleet/crew/roles/qa.md';
    const copy = join(home, 'projects', repo.repoId, 'crew', 'roles', 'qa.md');
    const first = await service.projects.scan(repo);
    await service.projects.saveSetup({ repo, setup: first.setup, imports: [qa] }, { finish: true });
    // The client edits their copy, and a teammate commits a new version.
    writeFileSync(copy, '# QA, our way\n');
    writeFiles(root, { [qa]: '# QA, the team way\n' });
    git(root, 'commit', '-qam', 'new qa');

    const scan = await service.projects.scan(repo);
    expect(scan.newer).toEqual([qa]);
    await service.projects.saveSetup({ repo, setup: scan.setup, imports: [qa] }, { finish: true });
    expect(readFileSync(copy, 'utf8')).toBe('# QA, our way\n');
    expect((await service.projects.scan(repo)).newer).toEqual([qa]);

    expect(await service.projects.importDiff({ repo, path: qa })).toEqual({
      path: qa,
      ours: '# QA, our way\n',
      theirs: '# QA, the team way\n'
    });
    await service.projects.saveSetup(
      { repo, setup: scan.setup, imports: [qa], updates: [qa] },
      { finish: true }
    );
    expect(readFileSync(copy, 'utf8')).toBe('# QA, the team way\n');
    expect((await service.projects.scan(repo)).newer).toEqual([]);
  });

  it('imports an agent file as a project crew role the Admiral can plan with', async () => {
    const agent = '.opencode/agents/journey-domain-reviewer.md';
    writeFiles(root, {
      [agent]: [
        '---',
        'description: >-',
        '  Reviews changes against the',
        '  journey domain rules.',
        'mode: subagent',
        'model: anthropic/claude-sonnet-4-5',
        'tools:',
        '  write: false',
        '---',
        'Check every change against docs/domain.md.',
        ''
      ].join('\n'),
      '.claude/agents/sweeper.md':
        '---\nname: sweeper\ndescription: Sweeps.\nmodel: haiku\n---\nSweep it.\n'
    });
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'agents');
    const scan = await service.projects.scan(repo);
    await service.projects.saveSetup(
      { repo, setup: scan.setup, imports: [agent, '.claude/agents/sweeper.md'] },
      { finish: true }
    );

    const crew = await service.crewCatalog(repo.repoId);
    expect(crew.errors).toEqual([]);
    expect(
      crew.roles.map(({ name, description, runtime, model, prompt }) => ({
        name,
        description,
        runtime,
        model,
        prompt
      }))
    ).toEqual([
      {
        name: 'journey-domain-reviewer',
        description: 'Reviews changes against the journey domain rules.',
        runtime: 'eva',
        model: undefined,
        prompt: 'Check every change against docs/domain.md.'
      },
      {
        name: 'sweeper',
        description: 'Sweeps.',
        runtime: 'claude',
        model: 'haiku',
        prompt: 'Sweep it.'
      }
    ]);
    // The repository's version is compared as the role it makes.
    expect((await service.projects.scan(repo)).newer).toEqual([]);
    const diff = await service.projects.importDiff({ repo, path: agent });
    expect(diff.ours).toBe(diff.theirs);
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
    expect(service.preferencesForNote(repo.repoId).project?.text).toMatch(
      /^P1\. Open PRs as drafts\. \(from starter questions, [\d-]+\)\nP2\. Use pnpm\./
    );
  });
});
