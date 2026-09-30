import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CHAIN_LIMIT,
  type FleetAsk,
  type FleetOpenTabRequest,
  type FleetSpawnArgs
} from '../../../../shared/fleet-tools';
import { createGitRunner } from '../../../claude-sessions/git-probe';
import type { FleetHost } from '../host';
import { FleetLedgerStore } from '../ledger-store';
import { ACT_LIMIT, ActLimiter } from '../limiter';
import { spawnSession, type FleetSpawnDeps } from '../spawn';
import { FleetSpawns, SPAWN_COMMAND, SPAWN_PROMPT_ENV } from '../spawns';

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const PANE = '9a8b7c6d-0000-4000-8000-000000000001';

describe('fleet_spawn', () => {
  let root: string;
  let repo: string;
  let plain: string;
  let asks: FleetAsk[];
  let answer: boolean;
  let tabs: Array<Omit<FleetOpenTabRequest, 'requestId'>>;
  let tabError: string | null;
  let made: Array<{ repo: string; branch: string | undefined }>;
  let removed: string[];
  let noted: Array<[string, string]>;
  let deps: FleetSpawnDeps;

  const args = (over: Partial<FleetSpawnArgs> = {}): FleetSpawnArgs => ({
    prompt: 'Add a test for the parser',
    why: 'the parser has none',
    expect: 'a passing test file',
    ...over
  });

  const approve = async (ask: FleetAsk): Promise<boolean> => {
    asks.push(ask);
    return Promise.resolve(answer);
  };

  const spawn = async (a = args(), cwd = plain): Promise<{ text: string; summary: string }> =>
    spawnSession(deps, THREAD, cwd, a, approve);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-spawn-')));
    repo = join(root, 'repo');
    plain = join(root, 'plain');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(plain);
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(root, 'file.txt'), 'x');
    asks = [];
    answer = true;
    tabs = [];
    tabError = null;
    made = [];
    removed = [];
    noted = [];
    const host: FleetHost = {
      tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
      sessions: () => [],
      starting: () => [],
      transcript: async () => Promise.resolve(null),
      inputsFor: () => [],
      git: createGitRunner(),
      now: () => 1_000_000
    };
    deps = {
      host,
      ledger: new FleetLedgerStore(root),
      limiter: new ActLimiter(),
      spawns: new FleetSpawns(),
      platform: 'linux',
      openTab: async (req) => {
        tabs.push(req);
        return Promise.resolve(tabError);
      },
      worktrees: {
        create: async (repoPath, branch) => {
          made.push({ repo: repoPath, branch });
          return Promise.resolve({
            worktreePath: join(root, 'wt'),
            branchName: branch ?? 'repo-calm-cove'
          });
        },
        remove: async (path) => {
          removed.push(path);
          return Promise.resolve();
        }
      },
      notePaneInput: (paneId, text) => noted.push([paneId, text]),
      newPaneId: () => PANE
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('asks, then opens an unfocused tab whose pane runs Claude Code with the prompt, once', async () => {
    const out = await spawn();
    expect(asks).toEqual([
      {
        action: 'spawn',
        sessionId: null,
        target: plain,
        prompt: '[orchestrator] Add a test for the parser'
      }
    ]);
    expect(tabs).toEqual([{ paneId: PANE, cwd: plain, label: 'plain', worktree: null }]);
    // The tab carries no prompt: it reaches the PTY from here, the first time only.
    expect(JSON.stringify(tabs)).not.toContain('parser');
    expect(deps.spawns.take(PANE)).toEqual({
      cmd: SPAWN_COMMAND,
      env: { [SPAWN_PROMPT_ENV]: '[orchestrator] Add a test for the parser' }
    });
    expect(deps.spawns.take(PANE)).toBeNull();
    expect(noted).toEqual([[PANE, '[orchestrator] Add a test for the parser']]);
    expect(deps.ledger.entries(THREAD)).toEqual([
      expect.objectContaining({
        id: '#1',
        action: 'spawn',
        ref: '9a8b7c6d',
        paneId: PANE,
        sessionId: null,
        why: 'the parser has none',
        expect: 'a passing test file',
        state: 'open',
        started: false
      })
    ]);
    expect(out.text).toContain('(ref 9a8b7c6d)');
    expect(out.text).toContain('folder trust dialog');
  });

  it('creates nothing when the user says no', async () => {
    answer = false;
    await expect(spawn(args({ worktree: true }), join(repo, 'src'))).rejects.toThrow(
      'The user did not let this session be started.'
    );
    expect(made).toEqual([]);
    expect(tabs).toEqual([]);
    expect(deps.spawns.starting()).toEqual([]);
    expect(deps.ledger.entries(THREAD)).toEqual([]);
  });

  it('makes a worktree of the repository and starts in the same place within it', async () => {
    await spawn(args({ worktree: true, branch: 'test/parser' }), join(repo, 'src'));
    expect(asks[0].target).toBe(`a new worktree of ${repo} on branch test/parser`);
    expect(made).toEqual([{ repo, branch: 'test/parser' }]);
    expect(tabs).toEqual([
      {
        paneId: PANE,
        cwd: join(root, 'wt', 'src'),
        label: 'test/parser',
        worktree: { path: join(root, 'wt'), branch: 'test/parser' }
      }
    ]);
  });

  it('refuses what it cannot do before asking', async () => {
    deps.platform = 'win32';
    await expect(spawn()).rejects.toThrow('not available on Windows');
    deps.platform = 'linux';
    await expect(spawn(args({ cwd: 'relative/dir' }))).rejects.toThrow('absolute path');
    await expect(spawn(args({ cwd: join(root, 'file.txt') }))).rejects.toThrow('is not a folder');
    await expect(spawn(args({ branch: 'x' }))).rejects.toThrow('set worktree too');
    await expect(spawn(args({ worktree: true }))).rejects.toThrow('not in a git repository');
    await expect(spawn(args({ prompt: 'end with \\' }))).rejects.toThrow('Not started');
    expect(asks).toEqual([]);
  });

  it('undoes the worktree and the pending prompt when the tab does not open', async () => {
    tabError = 'The Fleet window is not open.';
    await expect(spawn(args({ worktree: true }), repo)).rejects.toThrow(
      'Not started: The Fleet window is not open.'
    );
    expect(removed).toEqual([join(root, 'wt')]);
    expect(deps.spawns.take(PANE)).toBeNull();
    expect(deps.ledger.entries(THREAD)).toEqual([]);
  });

  it('counts against the same limit as sends', async () => {
    for (let i = 0; i < ACT_LIMIT; i++) deps.limiter.note(THREAD, 1_000_000);
    await expect(spawn()).rejects.toThrow(`made ${ACT_LIMIT} sends and spawns`);
    expect(asks).toEqual([]);
  });

  it('is paused with sends at the chain limit', async () => {
    for (let i = 0; i < FLEET_CHAIN_LIMIT; i++) deps.ledger.extendChain(THREAD);
    await expect(spawn()).rejects.toThrow('sends and spawns are paused until they write');
    expect(asks).toEqual([]);
  });
});

describe('FleetSpawns', () => {
  it('forgets its prompts on restart, so a restored tab is a plain shell', () => {
    const spawns = new FleetSpawns();
    spawns.add({ paneId: 'p', cwd: '/w', prompt: 'hi', at: 1 });
    expect(new FleetSpawns().take('p')).toBeNull();
  });

  it('reports a pane as starting until its session reports or it closes', () => {
    const spawns = new FleetSpawns();
    spawns.add({ paneId: 'p', cwd: '/w', prompt: 'hi', at: 1 });
    spawns.take('p');
    expect(spawns.starting().map((s) => s.paneId)).toEqual(['p']);
    spawns.settle('p');
    expect(spawns.starting()).toEqual([]);
  });
});
