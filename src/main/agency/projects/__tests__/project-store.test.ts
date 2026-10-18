import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectSetup } from '../../../../shared/agency-projects';
import { setupFilePath } from '../paths';
import {
  importDestination,
  loadSetup,
  parseSetupToml,
  saveSetup,
  setupToToml,
  shareWithTeam
} from '../project-store';
import { git, initRepo, tempDir } from './git-fixture';

/** The saved setup: its TOML, the files imported beside it, and "Share with team". */

const SETUP: ProjectSetup = {
  version: 1,
  kind: 'repo',
  name: 'shop',
  members: [
    {
      name: 'shop',
      path: '.',
      remote: 'git@github.com:acme/shop.git',
      defaultBranch: 'main',
      stack: ['Next.js', 'TypeScript'],
      packageManager: 'pnpm',
      setupCommand: 'pnpm install --frozen-lockfile',
      setupTimeoutSec: 600,
      checkCommands: ['pnpm run typecheck', 'pnpm run test'],
      checks: ['Unit tests', 'lint'],
      requiredChecks: ['Unit tests'],
      reviewBots: [],
      portVars: ['PORT', 'API_PORT'],
      fixedPorts: [{ port: 5432, service: 'db' }],
      envFiles: ['.env', 'config/.env.local']
    }
  ],
  imports: [],
  setupCommand: '',
  setupTimeoutSec: 600,
  stackSlots: 1
};

let tmp: { dir: string; cleanup: () => void };
let home: string;

beforeEach(() => {
  tmp = tempDir('fleet-project-store-');
  home = join(tmp.dir, 'agency-home');
});
afterEach(() => tmp.cleanup());

describe('setup TOML', () => {
  it('round-trips a setup, with each member as its own table', () => {
    const text = setupToToml(SETUP);
    expect(text).toContain('[[members]]');
    expect(text).toContain('setup_command = "pnpm install --frozen-lockfile"');
    expect(text).toContain('env_files = [ ".env", "config/.env.local" ]');
    expect(parseSetupToml(text)).toEqual(SETUP);
  });

  it('round-trips what TOML cannot say, a value not known, as a key left out', () => {
    const local: ProjectSetup = {
      ...SETUP,
      members: [{ ...SETUP.members[0], remote: null, defaultBranch: null, packageManager: null }],
      stackSlots: null
    };
    const text = setupToToml(local);
    expect(text).not.toContain('remote');
    expect(text).not.toContain('stack_slots');
    expect(parseSetupToml(text)).toEqual(local);
  });

  it('round-trips the workspace setup that runs after the members', () => {
    const umbrella: ProjectSetup = {
      ...SETUP,
      kind: 'submodules',
      setupCommand: 'make bootstrap',
      setupTimeoutSec: 1_200
    };
    const text = setupToToml(umbrella);
    expect(text).toContain('setup_command = "make bootstrap"');
    expect(parseSetupToml(text)).toEqual(umbrella);
  });

  it('turns away a file that is not TOML or not a setup', () => {
    expect(parseSetupToml('not = [toml')).toBeNull();
    expect(parseSetupToml('version = 2\nname = "x"\n[[members]]\nname = "x"\n')).toBeNull();
  });

  it('fills in what a hand-written file leaves out', () => {
    const setup = parseSetupToml('version = 1\nname = "shop"\n[[members]]\nname = "shop"\n');
    expect(setup?.members[0]).toMatchObject({ path: '.', setupTimeoutSec: 600, checks: [] });
  });
});

describe('saveSetup', () => {
  it('writes the setup and the imported files into the project folder, and reads it back', async () => {
    const repo = { repoId: '0123456789abcdef', root: '/repo', name: 'shop' };
    const { path, setup } = await saveSetup(
      {
        repo,
        setup: SETUP,
        imported: [
          {
            path: '.fleet/crew/roles/qa.md',
            kind: 'role',
            sha256: 'a'.repeat(64),
            content: '# QA\n'
          },
          {
            path: '.claude/agents/reviewer.md',
            kind: 'agent',
            sha256: 'b'.repeat(64),
            content: '# R\n'
          }
        ]
      },
      home
    );
    expect(path).toBe(setupFilePath(repo.repoId, home));
    expect(setup.imports.map((i) => i.path)).toEqual([
      '.fleet/crew/roles/qa.md',
      '.claude/agents/reviewer.md'
    ]);
    const dir = join(home, 'projects', repo.repoId);
    expect(readFileSync(join(dir, 'crew/roles/qa.md'), 'utf8')).toBe('# QA\n');
    expect(readFileSync(join(dir, 'crew/agents/reviewer.md'), 'utf8')).toBe('# R\n');
    expect(await loadSetup(repo.repoId, home)).toEqual(setup);
  });

  it('keeps imported files inside the project folder', () => {
    expect(importDestination('.fleet/crew/roles/qa.md')).toBe('crew/roles/qa.md');
    expect(importDestination('.fleet/fleet.agency.toml')).toBeNull();
    expect(importDestination('.claude/agents/../../x.md')).toBeNull();
    expect(importDestination('src/index.ts')).toBeNull();
  });
});

describe('shareWithTeam', () => {
  it('copies the setup and crew files into .fleet/ in the checkout, and commits nothing', async () => {
    const root = initRepo(join(tmp.dir, 'shop'), { 'README.md': 'shop\n' });
    const repo = { repoId: '0123456789abcdef', root, name: 'shop' };
    await saveSetup(
      {
        repo,
        setup: SETUP,
        imported: [
          {
            path: '.fleet/crew/roles/qa.md',
            kind: 'role',
            sha256: 'a'.repeat(64),
            content: '# QA\n'
          }
        ]
      },
      home
    );
    const head = git(root, 'rev-parse', 'HEAD');

    const written = await shareWithTeam(repo, home);

    expect(written).toEqual(['.fleet/fleet.agency.toml', '.fleet/crew/roles/qa.md']);
    expect(parseSetupToml(readFileSync(join(root, '.fleet/fleet.agency.toml'), 'utf8'))).toEqual({
      ...SETUP,
      imports: [{ path: '.fleet/crew/roles/qa.md', kind: 'role', sha256: 'a'.repeat(64) }]
    });
    expect(readFileSync(join(root, '.fleet/crew/roles/qa.md'), 'utf8')).toBe('# QA\n');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe('?? .fleet/');
  });

  it('leaves out a file the client unchecked since it was imported', async () => {
    const root = initRepo(join(tmp.dir, 'shop'), { 'README.md': 'shop\n' });
    const repo = { repoId: '0123456789abcdef', root, name: 'shop' };
    const qa = { path: '.fleet/crew/roles/qa.md', kind: 'role' as const, sha256: 'a'.repeat(64) };
    await saveSetup({ repo, setup: SETUP, imported: [{ ...qa, content: '# QA\n' }] }, home);
    await saveSetup({ repo, setup: SETUP, imported: [] }, home);

    expect(await shareWithTeam(repo, home)).toEqual(['.fleet/fleet.agency.toml']);
    expect(existsSync(join(root, '.fleet/crew/roles/qa.md'))).toBe(false);
  });

  it('refuses to write through a symlink the repository holds', async () => {
    const root = initRepo(join(tmp.dir, 'shop'), { 'README.md': 'shop\n' });
    const outside = join(tmp.dir, 'outside');
    mkdirSync(outside);
    mkdirSync(join(root, '.fleet'));
    symlinkSync(outside, join(root, '.fleet', 'crew'));
    const repo = { repoId: '0123456789abcdef', root, name: 'shop' };
    const qa = { path: '.fleet/crew/roles/qa.md', kind: 'role' as const, sha256: 'a'.repeat(64) };
    await saveSetup({ repo, setup: SETUP, imported: [{ ...qa, content: '# QA\n' }] }, home);

    await expect(shareWithTeam(repo, home)).rejects.toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
