import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGitRunner, probeGit } from '../git-probe';

let dir: string;

function git(...args: string[]): string {
  return gitIn(dir, ...args);
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
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

/**
 * A repository's config can name programs git runs while reading. Each case
 * first shows that plain git runs the program, so a pass means the runner
 * stopped it rather than that the setup never triggered it.
 */
describe('createGitRunner with a hostile repository', () => {
  let marker: string;
  const plain = (cwd: string, ...args: string[]): void => {
    try {
      gitIn(cwd, ...args);
    } catch {
      // A failed filter or gpg still ran; the marker is what counts.
    }
  };
  const ranProgram = (): boolean => {
    const ran = existsSync(marker);
    rmSync(marker, { force: true });
    return ran;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-git-hostile-'));
    marker = join(dir, 'ran');
    git('init', '-q', '-b', 'main');
    git('config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['a clean filter', 'filter.evil.clean', `sh -c 'touch "${'$'}0"; cat' MARKER`],
    ['a process filter', 'filter.evil.process', `sh -c 'touch "${'$'}0"; exit 1' MARKER`],
    ['a filter whose name holds "="', 'filter.a=b.clean', `sh -c 'touch "${'$'}0"; cat' MARKER`]
  ])('does not run %s', async (_, key, command) => {
    const driver = key.slice('filter.'.length, key.lastIndexOf('.'));
    writeFileSync(join(dir, '.gitattributes'), `*.txt filter=${driver}\n`);
    git('config', key, command.replace('MARKER', marker));
    git('config', `filter.${driver}.required`, 'true');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');

    plain(dir, 'diff', 'HEAD', '--shortstat');
    expect(ranProgram()).toBe(true);

    await probeGit(dir, run);
    await run(dir, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--', '.']).catch(() => {});
    expect(ranProgram()).toBe(false);
  });

  it('does not run gpg to show the signature of a signed commit', async () => {
    const gpg = join(dir, 'gpg.sh');
    writeFileSync(gpg, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(gpg, 0o755);
    git('config', 'gpg.program', gpg);
    git('config', 'log.showSignature', 'true');
    const signed = git('cat-file', 'commit', 'HEAD').replace(
      /^(committer .*)$/m,
      '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----'
    );
    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: dir,
      input: signed
    })
      .toString()
      .trim();
    git('update-ref', 'HEAD', sha);

    plain(dir, 'log', '-1');
    expect(ranProgram()).toBe(true);

    const out = await run(dir, ['log', '-1', '--format=%h %s']);
    expect(out.stdout).toContain('init');
    expect(ranProgram()).toBe(false);
  });

  it("does not look into a submodule, where the submodule's own filters apply", async () => {
    const lib = join(dir, 'lib-src');
    execFileSync('git', ['init', '-q', '-b', 'main', lib]);
    writeFileSync(join(lib, 'b.txt'), 'b\n');
    gitIn(lib, 'add', '.');
    gitIn(lib, 'commit', '-q', '-m', 'lib');
    git('-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', lib, 'lib');
    git('commit', '-q', '-m', 'add lib');
    // The submodule's filter is in its own config, which the outer listing does not see.
    const sub = join(dir, 'lib');
    writeFileSync(join(sub, '.gitattributes'), '*.txt filter=evil\n');
    gitIn(sub, 'config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`);
    git('config', 'submodule.lib.ignore', 'none');
    // Same size, so git has to hash the file, through the filter, to tell.
    writeFileSync(join(sub, 'b.txt'), 'c\n');

    plain(dir, 'status', '--porcelain');
    expect(ranProgram()).toBe(true);

    await probeGit(dir, run);
    expect(ranProgram()).toBe(false);
  });
});
