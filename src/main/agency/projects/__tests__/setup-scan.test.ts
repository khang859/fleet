import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgencyChanged, AgencyRepoRef } from '../../../../shared/agency';
import { AgencyService } from '../../index';
import type { GitRun } from '../../repo-identity';
import { repoAt } from '../../__tests__/plan-helpers';
import { readOnlyGit } from '../repo-reader';
import { repoTarget, scanProject } from '../setup-findings';
import { fakeGh, git, initRepo, tempDir, writeFiles } from './git-fixture';

/**
 * Setup's scan, on a real repository built to catch it out: package scripts
 * and git hooks that leave a marker if anything runs them, and an fsmonitor
 * hook in the repository's own config. The scan must find what a Node, pnpm
 * and GitHub Actions project says about itself, and leave no trace.
 */

const PACKAGE = JSON.stringify({
  name: 'shop',
  packageManager: 'pnpm@9.12.0',
  scripts: {
    typecheck: 'tsc --noEmit',
    lint: 'eslint .',
    test: 'vitest run',
    dev: 'next dev',
    preinstall: 'touch RAN_PREINSTALL',
    postinstall: 'touch RAN_POSTINSTALL',
    prepare: 'touch RAN_PREPARE'
  },
  dependencies: { next: '15.0.0', react: '19.0.0' },
  devDependencies: { typescript: '5.6.0' }
});

const WORKFLOW = `name: CI
on: [pull_request]
jobs:
  test:
    name: Unit tests
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
  matrix:
    name: Build \${{ matrix.os }}
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
`;

const TRAP = '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/RAN_HOOK"\n';

let home: { dir: string; cleanup: () => void };
let root: string;
let repo: AgencyRepoRef;
let emitted: AgencyChanged[];
let gitCalls: string[][];
let service: AgencyService;

/** Every git command the scan runs, as its subcommand and arguments. */
const recordingGit: GitRun = async (args, cwd) => {
  gitCalls.push(args);
  return readOnlyGit(args, cwd);
};

/** Who reviewed langfuse/langfuse's last 20 merged PRs, recorded from GitHub's GraphQL API. */
const REVIEW_AUTHORS = readFileSync(
  join(__dirname, 'fixtures', 'langfuse-review-authors.json'),
  'utf8'
);

const signedInGh = fakeGh((args) => {
  const call = args.join(' ');
  if (call === 'auth status') return { code: 0, stdout: '' };
  if (call.includes('/protection/required_status_checks')) {
    return { code: 0, stdout: JSON.stringify({ contexts: ['Unit tests'] }) };
  }
  if (call.startsWith('api graphql') && call.includes('pullRequests(states:MERGED')) {
    return { code: 0, stdout: REVIEW_AUTHORS };
  }
  if (call.includes('/rules/branches/')) {
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'lint' }] }
        }
      ])
    };
  }
  return { code: 1, stdout: '' };
});

/** Branches, worktrees, status and every file name: what a scan must leave as it found. */
function trace(): Record<string, string> {
  return {
    branches: git(root, 'branch', '--list', '--all'),
    worktrees: git(root, 'worktree', 'list', '--porcelain'),
    // With the fsmonitor off: the trap is for the scan, and status would spring it.
    status: git(root, '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--ignored'),
    head: git(root, 'rev-parse', 'HEAD'),
    files: readdirSync(root).sort().join(','),
    gitDir: readdirSync(join(root, '.git')).sort().join(',')
  };
}

beforeEach(() => {
  home = tempDir('fleet-setup-scan-');
  root = initRepo(
    join(home.dir, 'shop'),
    {
      'package.json': PACKAGE,
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'tsconfig.json': '{}',
      '.github/workflows/ci.yml': WORKFLOW,
      'CLAUDE.md': '# Shop\n\n- Use pnpm, never npm.\n- Run the API tests before a PR.\n',
      '.fleet/crew/roles/qa.md': '# QA\nClick through the checkout.\n',
      '.fleet/env-sync.json': '{}',
      '.claude/agents/reviewer.md': '# Reviewer\n',
      '.claude/skills/sweep/SKILL.md': '# Sweep\n',
      'fsmonitor.sh': TRAP
    },
    { origin: 'git@github.com:acme/shop.git' }
  );
  chmodSync(join(root, 'fsmonitor.sh'), 0o755);
  git(root, 'config', 'core.fsmonitor', './fsmonitor.sh');
  for (const hook of ['post-checkout', 'pre-commit', 'post-merge', 'reference-transaction']) {
    writeFiles(root, { [`.git/hooks/${hook}`]: TRAP });
    chmodSync(join(root, '.git', 'hooks', hook), 0o755);
  }
  repo = { repoId: '', root, name: 'shop' };
  emitted = [];
  gitCalls = [];
  service = new AgencyService({
    dbPath: join(home.dir, 'agency.db'),
    emit: (change) => emitted.push(change),
    hasModelKey: () => true,
    gh: signedInGh,
    agencyHome: join(home.dir, 'agency-home')
  });
});

afterEach(() => {
  service.close();
  home.cleanup();
});

const resolved = async (): Promise<AgencyRepoRef> => repoAt(service, root);

describe('setup scan', () => {
  it('finds the stack, pnpm, its checks, the CI jobs, the required checks and the remote', async () => {
    const scan = await scanProject(repoTarget({ ...repo, repoId: 'x' }), { gh: signedInGh });
    const member = scan.setup.members[0];
    expect(member).toMatchObject({
      name: 'shop',
      path: '.',
      remote: 'git@github.com:acme/shop.git',
      defaultBranch: 'main',
      stack: ['Next.js', 'TypeScript'],
      packageManager: 'pnpm',
      setupCommand: 'pnpm install --frozen-lockfile',
      checkCommands: ['pnpm run typecheck', 'pnpm run lint', 'pnpm run test'],
      // A job name built from an expression is only known at run time: its id stands in.
      checks: ['Unit tests', 'lint', 'matrix'],
      requiredChecks: ['Unit tests', 'lint'],
      // Bots only, the most reviews first: people who review as often are not review bots.
      reviewBots: ['claude[bot]', 'greptile-apps[bot]', 'chatgpt-codex-connector[bot]']
    });
    expect(scan.members[0].requiredChecksFrom).toBe('branch-protection');
    expect(scan.ghSignedIn).toBe(true);
    expect(scan.members[0].readFrom).toBe('main');
    expect(scan.repoFiles.map((f) => [f.path, f.kind, f.disposition])).toEqual([
      ['.claude/agents/reviewer.md', 'agent', 'importable'],
      ['.claude/skills/sweep', 'skill', 'in-place'],
      ['.fleet/crew/roles/qa.md', 'role', 'importable'],
      ['.fleet/env-sync.json', 'other', 'not-used'],
      ['CLAUDE.md', 'instructions', 'in-place']
    ]);
  });

  it('says why there are no required checks when the GitHub CLI is signed out', async () => {
    const signedOut = fakeGh(() => ({ code: 1, stdout: '' }));
    const scan = await scanProject(repoTarget({ ...repo, repoId: 'x' }), { gh: signedOut });
    expect(scan.setup.members[0].requiredChecks).toEqual([]);
    expect(scan.setup.members[0].reviewBots).toEqual([]);
    expect(scan.members[0].requiredChecksFrom).toBe('gh-signed-out');
  });

  it('reads the default branch, not uncommitted edits in the checkout', async () => {
    writeFiles(root, { 'package.json': JSON.stringify({ name: 'shop' }) });
    const scan = await scanProject(repoTarget({ ...repo, repoId: 'x' }), {});
    expect(scan.setup.members[0].packageManager).toBe('pnpm');
  });

  it('creates no pane, worktree or branch, and runs nothing from the repository', async () => {
    const before = trace();
    const ref = await resolved();
    const scan = await service.projects.scan(ref);
    await scanProject(repoTarget(ref), { git: recordingGit, gh: signedInGh });

    expect(scan.saved).toBe(false);
    expect(trace()).toEqual(before);
    for (const marker of ['RAN_HOOK', 'RAN_PREINSTALL', 'RAN_POSTINSTALL', 'RAN_PREPARE']) {
      expect(existsSync(join(root, marker))).toBe(false);
    }
    // No pane: nothing told a window to change, and nothing was saved.
    expect(emitted).toEqual([]);
    expect(existsSync(join(home.dir, 'agency-home'))).toBe(false);
    expect(service.store.onboarding(ref.repoId)).toEqual({
      setupDoneAt: null,
      starterDoneAt: null
    });
    // Only commands that read. File contents come through `cat-file blob`, outside `GitRun`;
    // `ls-files` lists the untracked env files.
    const READ_ONLY = new Set(['symbolic-ref', 'rev-parse', 'remote', 'ls-tree', 'ls-files']);
    for (const args of gitCalls) expect(READ_ONLY).toContain(args[0]);
    // And none that could start the repository's fsmonitor.
    expect(gitCalls.flat()).not.toContain('status');
    // The trap is live: an ordinary git status springs it.
    git(root, 'status', '--porcelain');
    expect(existsSync(join(root, 'RAN_HOOK'))).toBe(true);
  });

  it('refuses a repository the renderer names wrongly', async () => {
    const ref = await resolved();
    await expect(service.projects.scan({ ...ref, repoId: 'ffffffffffffffff' })).rejects.toThrow(
      /no longer the repository/
    );
  });
});
