import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner } from '../../../claude-sessions/git-probe';
import { createFleetCapability } from '../capability';
import type { FleetHost, FleetSession } from '../host';
import { FleetLedgerStore } from '../ledger-store';

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const signal = new AbortController().signal;

describe('fleet_diff', () => {
  let root: string;
  let repo: string;
  let fleet: ReturnType<typeof createFleetCapability>;
  let session: FleetSession;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-diff-')));
    repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=old\n');
    writeFileSync(join(repo, 'secret.pem'), 'old key\n');
    writeFileSync(join(repo, 'top.txt'), 'top old\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first commit');
    // What the session changed since.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=hunter2\n');
    writeFileSync(join(repo, 'secret.pem'), 'new key material\n');
    writeFileSync(join(repo, 'top.txt'), 'top new\n');
    writeFileSync(join(root, 'outside.txt'), 'not the session’s\n');

    session = {
      sessionId: 's',
      paneId: 'abcdef12-0000',
      ref: 'abcdef12',
      cwd: repo
    } as FleetSession;
    const host: FleetHost = {
      tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
      sessions: () => [session],
      transcript: async () => Promise.resolve(null),
      inputsFor: () => [],
      git: createGitRunner(),
      now: () => Date.now()
    };
    fleet = createFleetCapability(
      { host, ledger: new FleetLedgerStore(root), act: null },
      THREAD,
      'orchestrator'
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows the patch against HEAD without credential files', async () => {
    const out = await fleet.diff({ session: 'abcdef12', view: 'diff' }, signal);
    expect(out.text).toContain('-export const a = 1;');
    expect(out.text).toContain('+export const a = 2;');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).not.toContain('key material');
    expect(out.summary).toBe('2 files');
    expect(out.text).toMatch(/^<session-data session="abcdef12">/);
  });

  it('shows status and a diffstat', async () => {
    const out = await fleet.diff({ session: 'abcdef12', view: 'stat' }, signal);
    expect(out.text).toContain('## main');
    expect(out.text).toContain('src/a.ts | 2 +-');
    expect(out.summary).toBe('2 files changed, 2 insertions(+), 2 deletions(-)');
    expect(out.text).not.toContain('.env');
  });

  it('lists recent commits', async () => {
    const out = await fleet.diff({ session: 'abcdef12', view: 'log' }, signal);
    expect(out.text).toMatch(/[0-9a-f]{7} \d{4}-\d{2}-\d{2} Test: first commit/);
    expect(out.summary).toBe('1 commit');
  });

  it('narrows to a path inside the session folder', async () => {
    const out = await fleet.diff({ session: 'abcdef12', view: 'diff', path: 'src/a.ts' }, signal);
    expect(out.text).toContain('+export const a = 2;');
  });

  it('refuses a path outside the session folder', async () => {
    await expect(
      fleet.diff({ session: 'abcdef12', view: 'diff', path: '../outside.txt' }, signal)
    ).rejects.toThrow('outside the working folder');
    await expect(
      fleet.diff({ session: 'abcdef12', view: 'file', path: join(root, 'outside.txt') }, signal)
    ).rejects.toThrow('outside the working folder');
  });

  it('takes a path literally, so pathspec magic cannot reach above the session folder', async () => {
    session.cwd = join(repo, 'src');
    for (const view of ['stat', 'diff', 'log'] as const) {
      const out = await fleet.diff({ session: 'abcdef12', view, path: ':(top)top.txt' }, signal);
      expect(out.text).not.toContain('top.txt');
      expect(out.text).not.toContain('top new');
      expect(out.text).not.toContain('first commit');
    }
  });

  it('refuses credential files', async () => {
    await expect(
      fleet.diff({ session: 'abcdef12', view: 'file', path: '.env' }, signal)
    ).rejects.toThrow('may hold secrets');
    await expect(
      fleet.diff({ session: 'abcdef12', view: 'diff', path: '.env' }, signal)
    ).rejects.toThrow('may hold secrets');
  });

  it('reads a file in the session folder with line numbers', async () => {
    const out = await fleet.diff({ session: 'abcdef12', view: 'file', path: 'src/a.ts' }, signal);
    expect(out.text).toContain('src/a.ts lines 1-1\n1\texport const a = 2;');
  });
});
