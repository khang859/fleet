import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchPr,
  ghStatus,
  isTeamPr,
  listOpenPrs,
  makeBranchWorktree,
  makePrWorktree,
  openBranchPr,
  changesSince,
  parsePrInput,
  repoRoot,
  reportMarker,
  runProgram,
  type Exec,
  type PrWire
} from '../pr';

function wirePr(fields: Partial<PrWire> = {}): PrWire {
  return {
    number: 12,
    title: 'Fix it',
    html_url: 'https://github.com/acme/app/pull/12',
    state: 'open',
    draft: false,
    merged_at: null,
    author_association: 'MEMBER',
    user: { login: 'someone', type: 'User' },
    head: { sha: 'abc', repo: { full_name: 'acme/app' } },
    base: { repo: { full_name: 'acme/app' } },
    ...fields
  };
}

/** One line of `listOpenPrs`, as its `--jq` filter prints it. */
function openLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    draft: false,
    author_association: 'MEMBER',
    type: 'User',
    head: 'acme/app',
    base: 'acme/app',
    ...fields
  });
}

describe('parsePrInput', () => {
  it('reads a number', () => {
    expect(parsePrInput('123')).toEqual({ number: 123, repo: null });
    expect(parsePrInput(' #123 ')).toEqual({ number: 123, repo: null });
  });

  it('reads a link and its repo', () => {
    expect(parsePrInput('https://github.com/acme/app/pull/45/files')).toEqual({
      number: 45,
      repo: 'acme/app'
    });
  });

  it('refuses junk', () => {
    expect(parsePrInput('')).toBeNull();
    expect(parsePrInput('12a')).toBeNull();
    expect(parsePrInput('https://github.com/acme/app/issues/45')).toBeNull();
  });
});

describe('isTeamPr', () => {
  it('takes a member with a branch in the repo', () => {
    expect(isTeamPr(wirePr())).toBe(true);
    expect(isTeamPr(wirePr({ author_association: 'OWNER' }))).toBe(true);
  });

  it('refuses a fork, even from a member', () => {
    const head = { sha: 'abc', repo: { full_name: 'someone/app' } };

    expect(isTeamPr(wirePr({ head }))).toBe(false);
  });

  it('refuses a deleted fork', () => {
    expect(isTeamPr(wirePr({ head: { sha: 'abc', repo: null } }))).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(isTeamPr(wirePr({ author_association: 'CONTRIBUTOR' }))).toBe(false);
  });
});

describe('fetchPr', () => {
  it('asks gh for the PR and reads the answer', async () => {
    const exec = vi.fn<Exec>(async () => Promise.resolve(JSON.stringify(wirePr())));

    const info = await fetchPr(exec, '/repo', 12);

    expect(exec).toHaveBeenCalledWith('gh', ['api', 'repos/{owner}/{repo}/pulls/12'], '/repo');
    expect(info).toEqual({
      number: 12,
      title: 'Fix it',
      url: 'https://github.com/acme/app/pull/12',
      state: 'open',
      headSha: 'abc',
      team: true
    });
  });

  it('calls a merged PR merged', async () => {
    const merged = wirePr({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' });
    const exec: Exec = async () => Promise.resolve(JSON.stringify(merged));

    expect((await fetchPr(exec, '/repo', 12)).state).toBe('merged');
  });

  it('rejects an answer of the wrong shape', async () => {
    const exec: Exec = async () => Promise.resolve('{}');

    await expect(fetchPr(exec, '/repo', 12)).rejects.toThrow();
  });
});

describe('listOpenPrs', () => {
  it('flags drafts, bots and strangers', async () => {
    const lines = [
      openLine({ number: 12 }),
      openLine({ number: 2, draft: true, type: 'Bot' }),
      openLine({ number: 3, author_association: 'NONE' }),
      openLine({ number: 4, head: null })
    ];
    const exec: Exec = async () => Promise.resolve(`${lines.join('\n')}\n`);

    expect(await listOpenPrs(exec, '/repo')).toEqual([
      { number: 12, team: true, draft: false, bot: false },
      { number: 2, team: true, draft: true, bot: true },
      { number: 3, team: false, draft: false, bot: false },
      { number: 4, team: false, draft: false, bot: false }
    ]);
  });

  it('asks GitHub for every page', async () => {
    const exec = vi.fn<Exec>(async () => Promise.resolve(''));

    expect(await listOpenPrs(exec, '/repo')).toEqual([]);

    expect(exec.mock.calls[0][1]).toContain('--paginate');
  });
});

describe('makePrWorktree', () => {
  function git(cwd: string, ...args: string[]): string {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8' }).trim();
  }

  /** Real git, and a `gh` that only knows which repo this project uses. */
  function ghReads(slug: string): Exec {
    return async (command, args, cwd, input) =>
      command === 'gh' ? Promise.resolve(slug) : runProgram(command, args, cwd, input);
  }

  function addPrCommit(repo: string, number: number, text = `pr ${number}`): string {
    writeFileSync(join(repo, 'file.txt'), text);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', `pr ${number}`);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/pull/${number}/head`, sha);
    return sha;
  }

  it('gives each of many runs at once its own PR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-wf-pr-'));
    const origin = join(dir, 'origin');
    const project = join(dir, 'project');
    execFileSync('git', ['init', '-q', origin]);
    const numbers = [1, 2, 3, 4, 5, 6];
    const shas = numbers.map((number) => addPrCommit(origin, number));
    execFileSync('git', ['clone', '-q', origin, project]);

    const made = await Promise.all(
      numbers.map(async (number) =>
        makePrWorktree(ghReads(`${basename(dir)}/origin`), {
          projectPath: project,
          runId: `run0000${number}`,
          prNumber: number,
          base: join(dir, 'trees')
        })
      )
    );

    expect(made.map((worktree) => worktree.sha)).toEqual(shas);
    expect(git(project, 'for-each-ref', 'refs/fleet')).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fetches from the repo that gh reads, not from origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-wf-fork-'));
    const fork = join(dir, 'me', 'app.git');
    const upstream = join(dir, 'acme', 'app.git');
    const project = join(dir, 'project');
    execFileSync('git', ['init', '-q', fork]);
    execFileSync('git', ['init', '-q', upstream]);
    addPrCommit(fork, 3, 'the fork has its own PR 3');
    const wanted = addPrCommit(upstream, 3, 'the upstream PR 3');
    execFileSync('git', ['clone', '-q', fork, project]);
    git(project, 'remote', 'add', 'upstream', upstream);

    const made = await makePrWorktree(ghReads('Acme/App'), {
      projectPath: project,
      runId: 'runforks',
      prNumber: 3,
      base: join(dir, 'trees')
    });

    expect(made.sha).toBe(wanted);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when no remote holds the repo that gh reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-wf-noremote-'));
    const origin = join(dir, 'origin');
    const project = join(dir, 'project');
    execFileSync('git', ['init', '-q', origin]);
    addPrCommit(origin, 1);
    execFileSync('git', ['clone', '-q', origin, project]);

    const making = makePrWorktree(ghReads('acme/other'), {
      projectPath: project,
      runId: 'runnoway',
      prNumber: 1,
      base: join(dir, 'trees')
    });

    await expect(making).rejects.toThrow('No git remote points to acme/other');
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the pinned commit when the PR moved on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-wf-pin-'));
    const origin = join(dir, 'origin');
    const project = join(dir, 'project');
    execFileSync('git', ['init', '-q', origin]);
    const first = addPrCommit(origin, 1);
    execFileSync('git', ['clone', '-q', origin, project]);
    const spec = { projectPath: project, prNumber: 1, base: join(dir, 'trees') };
    const exec = ghReads(`${basename(dir)}/origin`);
    await makePrWorktree(exec, { ...spec, runId: 'runfirst' });
    addPrCommit(origin, 1, 'the PR moved on');

    const again = await makePrWorktree(exec, { ...spec, runId: 'runagain', pinnedSha: first });

    expect(again.sha).toBe(first);
    expect(git(again.path, 'rev-parse', 'HEAD')).toBe(first);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('new branch runs', () => {
  function git(cwd: string, ...args: string[]): string {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
    return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8' }).trim();
  }

  /** A project with one commit and an origin, and a `gh` that only records calls. */
  function makeProject(): { dir: string; project: string; calls: string[][]; exec: Exec } {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-wf-branch-'));
    const origin = join(dir, 'acme', 'app.git');
    const project = join(dir, 'project');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', origin, project], { stdio: 'ignore' });
    writeFileSync(join(project, 'file.txt'), 'one');
    git(project, 'add', '.');
    git(project, 'commit', '-m', 'start');
    git(project, 'push', 'origin', 'HEAD:main');
    git(project, 'remote', 'set-head', 'origin', 'main');
    const calls: string[][] = [];
    const exec: Exec = async (command, args, cwd, input) => {
      if (command !== 'gh') return runProgram(command, args, cwd, input);
      calls.push([...args, input ?? '']);
      if (args[0] === 'pr' && args[1] === 'view') return Promise.reject(new Error('no PR'));
      if (args[0] === 'pr') return Promise.resolve('https://github.com/acme/app/pull/31\n');
      return Promise.resolve('acme/app');
    };
    return { dir, project, calls, exec };
  }

  async function branchOf(
    project: string,
    dir: string,
    exec: Exec
  ): ReturnType<typeof makeBranchWorktree> {
    const spec = { projectPath: project, runId: 'abcdef123', slug: 'task', base: dir };
    return makeBranchWorktree(exec, spec);
  }

  function commit(path: string): void {
    writeFileSync(join(path, 'new.txt'), 'two');
    git(path, 'add', '.');
    git(path, 'commit', '-m', 'Add the new file');
  }

  it('makes a branch from the default branch', async () => {
    const { dir, project, exec } = makeProject();

    const { path, branch } = await branchOf(project, join(dir, 'trees'), exec);

    expect(branch).toMatchObject({ name: 'fleet/task', base: 'main' });
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fleet/task');
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes a new name when the branch exists', async () => {
    const { dir, project, exec } = makeProject();
    git(project, 'branch', 'fleet/task');

    const { branch } = await branchOf(project, join(dir, 'trees'), exec);

    expect(branch.name).toBe('fleet/task-abcdef');
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows work with no commit in the diff', async () => {
    const { dir, project, exec } = makeProject();
    const { path, branch } = await branchOf(project, join(dir, 'trees'), exec);
    writeFileSync(join(path, 'file.txt'), 'changed');

    expect(await changesSince(exec, path, branch.baseSha)).toContain('+changed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens no PR for a branch with no commits', async () => {
    const { dir, project, exec, calls } = makeProject();
    const { path, branch } = await branchOf(project, join(dir, 'trees'), exec);
    const spec = { projectPath: project, worktreePath: path, branch, body: 'Report' };

    expect(await openBranchPr(exec, spec)).toEqual({
      ok: false,
      why: 'The branch has no commits.'
    });
    expect(calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens no PR with work that nobody committed', async () => {
    const { dir, project, exec } = makeProject();
    const { path, branch } = await branchOf(project, join(dir, 'trees'), exec);
    commit(path);
    writeFileSync(join(path, 'more.txt'), 'three');
    const spec = { projectPath: project, worktreePath: path, branch, body: 'Report' };

    const result = await openBranchPr(exec, spec);

    expect(result).toMatchObject({ ok: false, why: expect.stringContaining('no commit') });
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the report through stdin, and the title from git', async () => {
    const { dir, project, exec, calls } = makeProject();
    const { path, branch } = await branchOf(project, join(dir, 'trees'), exec);
    commit(path);
    const body = '--title is not a flag here';
    const spec = { projectPath: project, worktreePath: path, branch, body };

    const result = await openBranchPr(exec, spec);

    expect(result).toEqual({
      ok: true,
      number: 31,
      url: 'https://github.com/acme/app/pull/31'
    });
    const create = calls.find((call) => call[1] === 'create') ?? [];
    expect(create).toContain('Add the new file');
    expect(create.at(-1)).toBe(body);
    expect(create.slice(0, -1)).not.toContain(body);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('small helpers', () => {
  it('falls back to the folder outside a repo', async () => {
    const fails: Exec = async () => Promise.reject(new Error('no repo'));

    expect(await repoRoot(fails, '/folder')).toBe('/folder');
  });

  it('says why gh is not ready', async () => {
    const fails: Exec = async () => Promise.reject(new Error('not signed in'));

    expect(await ghStatus(fails, '/repo')).toEqual({ ok: false, detail: 'not signed in' });
  });

  it('makes a hidden mark per report', () => {
    expect(reportMarker('run-1')).toBe('<!-- fleet:report:run-1 -->');
  });
});
