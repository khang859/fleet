import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentTool } from '../run';
import { globMatcher } from '../glob-match';
import { ignoreDecision, parseIgnoreRules } from '../ignore';

/**
 * The read-only tools, against a real folder on disk.
 *
 * Two things are being protected here. One is the sandbox: a tool that can be
 * talked out of the working folder is a tool that can read anything the app
 * can. The other is honesty about size - every result is cut somewhere, and a
 * cut that does not announce itself turns a partial answer into a wrong one.
 */

let dir: string;

/** Write a file, creating the folders above it. */
function file(rel: string, contents: string): string {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

const run = async (name: string, args: object): Promise<{ text: string; summary: string }> =>
  runAgentTool(name, JSON.stringify(args), dir);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-tools-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('read', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

  it('numbers the lines it returns', async () => {
    file('a.txt', 'first\nsecond\nthird');

    const { text } = await run('read', { path: 'a.txt' });

    expect(text).toContain('1\tfirst');
    expect(text).toContain('3\tthird');
  });

  it('reads a window and says where the next one starts', async () => {
    file('big.txt', hundred);

    const { text, summary } = await run('read', { path: 'big.txt', limit: 10 });

    expect(text).toContain('lines 1-10');
    expect(text).toContain('line 10');
    expect(text).not.toContain('line 11');
    expect(text).toContain('offset=11');
    expect(summary).toBe('10 lines');
  });

  it('starts where offset says', async () => {
    file('big.txt', hundred);

    const { text } = await run('read', { path: 'big.txt', offset: 95 });

    expect(text).toContain('95\tline 95');
    expect(text).not.toContain('line 94');
    // The window runs past the end, so this is the end of the file.
    expect(text).toContain('(end of big.txt)');
  });

  // The default is the whole contract of this tool: small, and extendable.
  it('stops at 200 lines when no limit is given', async () => {
    file('huge.txt', Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'));

    const { text, summary } = await run('read', { path: 'huge.txt' });

    expect(summary).toBe('200 lines');
    expect(text).toContain('line 200');
    expect(text).not.toContain('line 201');
    expect(text).toContain('offset=201');
  });

  it('refuses a limit past the ceiling instead of quietly capping it', async () => {
    file('a.txt', 'x');

    await expect(run('read', { path: 'a.txt', limit: 9999 })).rejects.toThrow(/limit/);
  });

  it('cuts a very long line and says by how much', async () => {
    file('min.js', `const a=1;${'x'.repeat(3000)}`);

    const { text } = await run('read', { path: 'min.js' });

    expect(text).toContain('more characters on this line');
    expect(text.length).toBeLessThan(3000);
  });

  it('says a file is empty rather than returning nothing', async () => {
    file('empty.txt', '');

    expect((await run('read', { path: 'empty.txt' })).summary).toBe('empty file');
  });

  it('refuses a binary file', async () => {
    writeFileSync(join(dir, 'bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x00, 0x01]));

    await expect(run('read', { path: 'bin' })).rejects.toThrow(/binary/);
  });

  it('sends the model somewhere useful when given a folder', async () => {
    mkdirSync(join(dir, 'src'));

    await expect(run('read', { path: 'src' })).rejects.toThrow(/glob/);
  });

  it('reports a missing file as missing', async () => {
    await expect(run('read', { path: 'nope.ts' })).rejects.toThrow(/does not exist/);
  });
});

describe('the sandbox', () => {
  it('refuses a path above the working folder', async () => {
    await expect(run('read', { path: '../secrets.txt' })).rejects.toThrow(/outside/);
  });

  it('refuses an absolute path elsewhere', async () => {
    await expect(run('read', { path: '/etc/hosts' })).rejects.toThrow(/outside/);
  });

  // The interesting case: the path is inside the folder and the file is not.
  it('refuses a symlink that points out of the folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-agent-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'password');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

    try {
      await expect(run('read', { path: 'link.txt' })).rejects.toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a secrets file inside the folder', async () => {
    file('.env', 'API_KEY=sk-live-1');

    await expect(run('read', { path: '.env' })).rejects.toThrow(/secrets/);
  });

  it('keeps secrets files out of a search as well', async () => {
    file('.env', 'API_KEY=sk-live-1');
    file('app.ts', 'const key = process.env.API_KEY;');

    const { text } = await run('grep', { pattern: 'API_KEY' });

    expect(text).toContain('app.ts');
    expect(text).not.toContain('sk-live-1');
  });
});

describe('glob', () => {
  it('finds files by pattern, newest first', async () => {
    file('src/old.ts', '1');
    file('src/new.ts', '2');
    utimesSync(join(dir, 'src/old.ts'), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(dir, 'src/new.ts'), new Date(2_000_000), new Date(2_000_000));

    const { text, summary } = await run('glob', { pattern: '**/*.ts' });

    expect(summary).toBe('2 files');
    expect(text.indexOf('src/new.ts')).toBeLessThan(text.indexOf('src/old.ts'));
  });

  it('matches a bare pattern against the file name at any depth', async () => {
    file('a/b/c/deep.ts', '1');

    expect((await run('glob', { pattern: '*.ts' })).text).toContain('a/b/c/deep.ts');
  });

  it('says plainly when nothing matches', async () => {
    file('a.ts', '1');

    expect((await run('glob', { pattern: '*.py' })).summary).toBe('no files');
  });

  it('skips what .gitignore skips', async () => {
    file('.gitignore', 'dist/\n*.log\n');
    file('dist/bundle.ts', '1');
    file('debug.log', '1');
    file('src/app.ts', '1');

    const { text } = await run('glob', { pattern: '**/*' });

    expect(text).toContain('src/app.ts');
    expect(text).not.toContain('dist/bundle.ts');
    expect(text).not.toContain('debug.log');
  });

  it('never returns anything from .git', async () => {
    file('.git/config', 'url = git@github.com:x/y');
    file('a.ts', '1');

    expect((await run('glob', { pattern: '**/*' })).text).not.toContain('.git/config');
  });
});

describe('grep', () => {
  beforeEach(() => {
    file('src/a.ts', 'export function alpha() {}\nconst x = 1;');
    file('src/b.ts', 'import { alpha } from "./a";\nalpha();');
    file('README.md', 'alpha is the first letter');
  });

  it('returns the matching lines with file and line number', async () => {
    const { text, summary } = await run('grep', { pattern: 'alpha\\(\\)' });

    expect(text).toContain('src/a.ts:1: export function alpha() {}');
    expect(text).toContain('src/b.ts:2: alpha();');
    expect(summary).toBe('2 matches in 2 files');
  });

  it('narrows to the files the glob names', async () => {
    const { text } = await run('grep', { pattern: 'alpha', glob: '**/*.md' });

    expect(text).toContain('README.md');
    expect(text).not.toContain('src/a.ts');
  });

  it('returns only paths in files mode', async () => {
    const { text, summary } = await run('grep', { pattern: 'alpha', mode: 'files' });

    expect(text).toContain('src/a.ts');
    expect(text).not.toContain('export function');
    expect(summary).toBe('3 files');
  });

  it('honours ignoreCase only when asked', async () => {
    expect((await run('grep', { pattern: 'ALPHA' })).summary).toBe('no matches');
    expect((await run('grep', { pattern: 'ALPHA', ignoreCase: true })).summary).not.toBe(
      'no matches'
    );
  });

  it('searches one file when pointed at one', async () => {
    const { summary } = await run('grep', { pattern: 'alpha', path: 'README.md' });

    expect(summary).toBe('1 match in 1 file');
  });

  it('hands a bad pattern back to be fixed', async () => {
    await expect(run('grep', { pattern: '([unclosed' })).rejects.toThrow(
      /not a valid regular expression/
    );
  });

  it('says how many matches it did not show', async () => {
    file('many.txt', Array.from({ length: 120 }, () => 'needle').join('\n'));

    const { text, summary } = await run('grep', { pattern: 'needle' });

    expect(summary).toContain('120 matches');
    expect(text).toContain('more matches');
    expect(text.split('\n').filter((l) => l.startsWith('many.txt:'))).toHaveLength(50);
  });

  it('returns matches in path order however the disk answers', async () => {
    for (const name of ['z.txt', 'a.txt', 'm.txt']) file(name, 'needle');

    const { text } = await run('grep', { pattern: 'needle' });
    const order = text.split('\n').filter((l) => l.includes('.txt:'));

    expect(order.map((l) => l.split(':')[0])).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });
});

describe('the call itself', () => {
  it('rejects a tool that does not exist', async () => {
    await expect(runAgentTool('rm', '{}', dir)).rejects.toThrow(/no tool called rm/);
  });

  it('explains malformed arguments instead of failing the turn', async () => {
    await expect(runAgentTool('read', '{"path": "a.ts"', dir)).rejects.toThrow(/not valid JSON/);
  });

  it('names the argument that was wrong', async () => {
    await expect(runAgentTool('read', '{}', dir)).rejects.toThrow(/path/);
  });
});

describe('glob patterns', () => {
  const matches = (pattern: string, path: string): boolean => globMatcher(pattern)(path);

  it('stops * at a separator and lets ** cross one', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(matches('src/**/*.ts', 'src/deep/a.ts')).toBe(true);
  });

  // The one that makes `src/**/*.ts` mean what people expect it to mean.
  it('lets ** stand for no directories at all', () => {
    expect(matches('src/**/*.ts', 'src/a.ts')).toBe(true);
  });

  it('handles alternation and character classes', () => {
    expect(matches('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(matches('*.{ts,tsx}', 'a.js')).toBe(false);
    expect(matches('file[0-9].ts', 'file7.ts')).toBe(true);
  });

  it('treats a dot as a literal dot', () => {
    expect(matches('*.ts', 'ats')).toBe(false);
  });
});

describe('ignore rules', () => {
  const decide = (rules: string, path: string, isDir = false): boolean | null =>
    ignoreDecision(parseIgnoreRules(rules), path, isDir);

  it('ignores nothing for comments and blank lines', () => {
    expect(decide('# a comment\n\n', 'a.ts')).toBeNull();
  });

  it('lets a later negation win', () => {
    expect(decide('*.log\n!keep.log', 'keep.log')).toBe(false);
    expect(decide('*.log\n!keep.log', 'other.log')).toBe(true);
  });

  it('applies a trailing slash to folders only', () => {
    expect(decide('build/', 'build', true)).toBe(true);
    expect(decide('build/', 'build', false)).toBeNull();
  });

  it('anchors a leading slash to the ignore file own folder', () => {
    expect(decide('/dist', 'dist')).toBe(true);
    expect(decide('/dist', 'packages/dist')).toBeNull();
  });

  it('matches an unanchored name at any depth', () => {
    expect(decide('node_modules', 'a/b/node_modules', true)).toBe(true);
  });
});
