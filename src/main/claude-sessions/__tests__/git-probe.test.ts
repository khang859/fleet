import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGitRunner, probeGit } from '../git-probe';

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).toString();
}

const run = createGitRunner();

describe('probeGit', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-git-probe-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null outside a repository', async () => {
    expect(await probeGit(dir, run)).toBeNull();
  });

  it('names the branch of a repository with no commits', async () => {
    git('init', '-q', '-b', 'trunk');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    expect(await probeGit(dir, run)).toEqual({
      branch: 'trunk',
      dirtyFiles: 1,
      insertions: 0,
      deletions: 0,
      truncated: false
    });
  });

  it('counts dirty files and the diff against HEAD', async () => {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'feature/probe');

    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n'); // +2 -1
    renameSync(join(dir, 'b.txt'), join(dir, 'c.txt'));
    git('add', '-A'); // staged rename: one entry plus its old path under -z
    writeFileSync(join(dir, 'new file.txt'), 'x\n');

    expect(await probeGit(dir, run)).toEqual({
      branch: 'feature/probe',
      dirtyFiles: 3,
      insertions: 2,
      deletions: 1,
      truncated: false
    });
  });

  it('shows a short commit id when HEAD is detached', async () => {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const sha = git('rev-parse', '--short', 'HEAD').trim();
    git('checkout', '-q', '--detach');
    expect((await probeGit(dir, run))?.branch).toBe(sha);
  });

  it('marks counts from capped output as truncated', async () => {
    git('init', '-q', '-b', 'main');
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), 'x');
    const summary = await probeGit(dir, createGitRunner({ maxBytes: 200 }));
    expect(summary?.truncated).toBe(true);
    expect(summary?.dirtyFiles).toBeGreaterThan(0);
    expect(summary?.dirtyFiles).toBeLessThan(50);
  });

  it('gives up on a git that takes too long', async () => {
    git('init', '-q', '-b', 'main');
    const slow = createGitRunner({ timeoutMs: 50 });
    await expect(slow(dir, ['-c', 'alias.wait=!sleep 1', 'wait'])).rejects.toThrow(/timed out/);
  });
});
