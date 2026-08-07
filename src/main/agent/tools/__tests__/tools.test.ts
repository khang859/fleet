import {
  existsSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTPUT_SEPARATOR,
  type AgentToolContext,
  type AgentToolResult
} from '../../../../shared/agent-tools';
import { runAgentTool } from '../run';
import { forgetAllFiles } from '../freshness';
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

/** Commands handed to the user this test, oldest first. */
let handedOff: string[];

/** Commands the turn has been told no about, for the tests that set one. */
let refused: string[];

/** The conversation every test runs in unless it says otherwise. */
const ctx = (threadId = 'thread-1', signal = new AbortController().signal): AgentToolContext => ({
  cwd: dir,
  threadId,
  signal,
  handOff: (command) => handedOff.push(command),
  approve: async () => Promise.resolve(true),
  wasRefused: (command) => refused.includes(command),
  // No image model, which is the default and what every test here runs under.
  // The image tool has its own file.
  generateImage: null,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  // The todo tools have their own file too, and nothing here calls them.
  todos: { list: () => [], save: () => {} }
});

const run = async (name: string, args: object): Promise<AgentToolResult> =>
  runIn('thread-1', name, args);

const runIn = async (threadId: string, name: string, args: object): Promise<AgentToolResult> =>
  runAgentTool(name, JSON.stringify(args), ctx(threadId));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-tools-'));
  handedOff = [];
  refused = [];
  // What a conversation has read outlives the conversation's own turns, so each
  // test starts as though the app had just opened and nothing had been read.
  forgetAllFiles();
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

  // The whole point of the image branch: a screenshot used to be "that is a
  // binary file", and is now something the model can actually look at.
  it.each([
    ['shot.png', 'image/png'],
    ['shot.jpg', 'image/jpeg'],
    ['shot.jpeg', 'image/jpeg'],
    ['shot.webp', 'image/webp'],
    ['shot.gif', 'image/gif']
  ])('hands back %s as a picture rather than as text', async (name, mimeType) => {
    writeFileSync(join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    const result = await run('read', { path: name });

    // The real path, the way every tool resolves one: the temp folder is
    // itself behind a symlink on macOS.
    expect(result.image).toEqual({ path: realpathSync(join(dir, name)), mimeType });
    expect(result.text).toContain('is an image');
  });

  // Not a picture: it is XML, no provider decodes it as one, and the text of it
  // is more use to a model than a render would be.
  it('still reads an svg as text', async () => {
    file('logo.svg', '<svg><title>logo</title></svg>');

    const result = await run('read', { path: 'logo.svg' });

    expect(result.image).toBeUndefined();
    expect(result.text).toContain('<title>logo</title>');
  });

  it('refuses an image too large to look at', async () => {
    writeFileSync(join(dir, 'huge.png'), Buffer.alloc(8_000_001));

    await expect(run('read', { path: 'huge.png' })).rejects.toThrow(/too large/);
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
    await expect(runAgentTool('rm', '{}', ctx())).rejects.toThrow(/no tool called rm/);
  });

  it('explains malformed arguments instead of failing the turn', async () => {
    await expect(runAgentTool('read', '{"path": "a.ts"', ctx())).rejects.toThrow(/not valid JSON/);
  });

  it('names the argument that was wrong', async () => {
    await expect(runAgentTool('read', '{}', ctx())).rejects.toThrow(/path/);
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

describe('edit', () => {
  /** An edit is only allowed on a file the agent has read, so read it first. */
  const readThen = async (
    rel: string,
    args: object
  ): Promise<{ text: string; summary: string }> => {
    await run('read', { path: rel });
    return run('edit', { path: rel, ...args });
  };

  it('replaces an exact match and reports a diff', async () => {
    file('a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const { text, summary } = await readThen('a.ts', {
      oldString: 'const b = 2;',
      newString: 'const b = 22;'
    });

    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(
      'const a = 1;\nconst b = 22;\nconst c = 3;\n'
    );
    expect(summary).toBe('+1 -1');
    expect(text).toContain('Edited a.ts (+1 -1)');
    expect(text).toContain('-const b = 2;');
    expect(text).toContain('+const b = 22;');
  });

  it('refuses to edit a file it has not read', async () => {
    file('a.ts', 'const a = 1;\n');

    await expect(
      run('edit', { path: 'a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' })
    ).rejects.toThrow(/Read a.ts before changing it/);
  });

  it('refuses to edit a file that changed since it was read', async () => {
    file('a.ts', 'const a = 1;\n');
    await run('read', { path: 'a.ts' });
    file('a.ts', 'const a = 1;\nconst b = 2;\n');

    await expect(
      run('edit', { path: 'a.ts', oldString: 'const a = 1;', newString: 'const a = 2;' })
    ).rejects.toThrow(/changed on disk since you read it/);
  });

  it('does not let one conversation read on behalf of another', async () => {
    file('a.ts', 'const a = 1;\n');
    await runIn('thread-1', 'read', { path: 'a.ts' });

    await expect(
      runIn('thread-2', 'edit', {
        path: 'a.ts',
        oldString: 'const a = 1;',
        newString: 'const a = 2;'
      })
    ).rejects.toThrow(/Read a.ts before changing it/);
  });

  it('refuses when another conversation rewrote the file since the read', async () => {
    file('a.ts', 'const a = 1;\n');
    await runIn('thread-1', 'read', { path: 'a.ts' });
    await runIn('thread-2', 'read', { path: 'a.ts' });
    // A change of length as well as of time: two writes inside the same
    // millisecond would otherwise leave the stamps identical on some filesystems.
    await runIn('thread-2', 'edit', {
      path: 'a.ts',
      oldString: 'const a = 1;',
      newString: 'const a = 2;\nconst b = 2;'
    });

    await expect(
      runIn('thread-1', 'edit', {
        path: 'a.ts',
        oldString: 'const a = 1;',
        newString: 'const a = 3;'
      })
    ).rejects.toThrow(/changed on disk since you read it/);
  });

  it('allows a second edit to a file it just edited', async () => {
    file('a.ts', 'one\ntwo\n');

    await readThen('a.ts', { oldString: 'one', newString: '1' });
    await run('edit', { path: 'a.ts', oldString: 'two', newString: '2' });

    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('1\n2\n');
  });

  it('refuses an ambiguous match and names where it matched', async () => {
    file('a.ts', 'x = 1;\ny = 2;\nx = 1;\n');

    await expect(readThen('a.ts', { oldString: 'x = 1;', newString: 'x = 9;' })).rejects.toThrow(
      /appears 2 times \(lines 1, 3\)/
    );
  });

  it('changes every occurrence when asked to', async () => {
    file('a.ts', 'x = 1;\ny = 2;\nx = 1;\n');

    const { summary } = await readThen('a.ts', {
      oldString: 'x = 1;',
      newString: 'x = 9;',
      replaceAll: true
    });

    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('x = 9;\ny = 2;\nx = 9;\n');
    expect(summary).toBe('+2 -2');
  });

  it('matches lines whose indentation the model got wrong, and re-indents the replacement', async () => {
    file('a.ts', 'function f() {\n    if (x) {\n        go();\n    }\n}\n');

    const { text } = await readThen('a.ts', {
      oldString: 'if (x) {\n    go();\n}',
      newString: 'if (y) {\n    stop();\n}'
    });

    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(
      'function f() {\n    if (y) {\n        stop();\n    }\n}\n'
    );
    expect(text).toContain('ignoring indentation');
  });

  it('refuses when ignoring indentation makes the match ambiguous', async () => {
    // The same two lines twice, at two different indentations - so neither is
    // an exact match for what the model wrote, and both match once trimmed.
    file('a.ts', 'if (a) {\n    go();\n}\n  if (a) {\n      go();\n  }\n');

    await expect(
      readThen('a.ts', { oldString: 'if (a) {\n  go();\n}', newString: 'if (b) {\n  stop();\n}' })
    ).rejects.toThrow(/matches 2 places \(lines 1, 4\)/);
  });

  it('points at where the first line is when the rest does not match', async () => {
    file('a.ts', 'const a = 1;\nconst b = 2;\n');

    await expect(
      readThen('a.ts', { oldString: 'const a = 1;\nconst z = 9;', newString: 'nope' })
    ).rejects.toThrow(/first line is at line 1/);
  });

  it('says so when the text is nowhere in the file', async () => {
    file('a.ts', 'const a = 1;\n');

    await expect(
      readThen('a.ts', { oldString: 'const q = 7;', newString: 'nope' })
    ).rejects.toThrow(/neither is its first line/);
  });

  it('refuses an edit that changes nothing', async () => {
    file('a.ts', 'const a = 1;\n');

    await expect(
      readThen('a.ts', { oldString: 'const a = 1;', newString: 'const a = 1;' })
    ).rejects.toThrow(/identical/);
  });

  it('keeps the line endings the file already had', async () => {
    file('crlf.ts', 'one\r\ntwo\r\nthree\r\n');

    await readThen('crlf.ts', { oldString: 'two', newString: 'TWO' });

    expect(readFileSync(join(dir, 'crlf.ts'), 'utf8')).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('refuses a file that does not exist, and a folder', async () => {
    mkdirSync(join(dir, 'sub'));

    await expect(run('edit', { path: 'nope.ts', oldString: 'a', newString: 'b' })).rejects.toThrow(
      /does not exist - use write to create it/
    );
    await expect(run('edit', { path: 'sub', oldString: 'a', newString: 'b' })).rejects.toThrow(
      /is a folder/
    );
  });

  it('stays inside the working folder', async () => {
    await expect(
      run('edit', { path: '../../../etc/hosts', oldString: 'a', newString: 'b' })
    ).rejects.toThrow(/outside the working folder/);
  });
});

describe('write', () => {
  it('creates a file and the folders above it', async () => {
    const { text, summary } = await run('write', {
      path: 'src/deep/new.ts',
      content: 'export const a = 1;\n'
    });

    expect(readFileSync(join(dir, 'src/deep/new.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(text).toContain('Created src/deep/new.ts (1 line)');
    expect(summary).toBe('1 line');
  });

  it('refuses to overwrite a file it has not read', async () => {
    file('a.ts', 'work in progress\n');

    await expect(run('write', { path: 'a.ts', content: 'gone\n' })).rejects.toThrow(
      /Read a.ts before changing it/
    );
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('work in progress\n');
  });

  it('overwrites a file it has read, and reports what that did', async () => {
    file('a.ts', 'one\ntwo\n');
    await run('read', { path: 'a.ts' });

    const { text, summary } = await run('write', { path: 'a.ts', content: 'one\nTWO\n' });

    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('one\nTWO\n');
    expect(text).toContain('Rewrote a.ts (+1 -1)');
    expect(summary).toBe('+1 -1');
  });

  it('does not write a file that already says that', async () => {
    file('a.ts', 'same\n');
    await run('read', { path: 'a.ts' });

    const { summary } = await run('write', { path: 'a.ts', content: 'same\n' });

    expect(summary).toBe('no change');
  });

  it('refuses a folder and anything outside the working folder', async () => {
    mkdirSync(join(dir, 'sub'));

    await expect(run('write', { path: 'sub', content: 'x' })).rejects.toThrow(/is a folder/);
    await expect(run('write', { path: '../escape.ts', content: 'x' })).rejects.toThrow(
      /outside the working folder/
    );
  });

  it('refuses a path that holds secrets', async () => {
    await expect(run('write', { path: '.env', content: 'KEY=1' })).rejects.toThrow(
      /may hold secrets/
    );
  });
});

describe('what a change tells the model', () => {
  // The reminders exist because the system prompt alone does not hold up over a
  // long turn on every model. They are worth their tokens only while they stay
  // attached to a change and out of every other result.
  it('reminds the model that the user can already see the change', async () => {
    file('a.ts', 'one\n');
    await run('read', { path: 'a.ts' });

    const edited = await run('edit', { path: 'a.ts', oldString: 'one', newString: 'two' });
    const created = await run('write', { path: 'b.ts', content: 'hello\n' });

    expect(edited.text).toContain('do not repeat the new code');
    expect(created.text).toContain('do not repeat its contents');
  });

  it('says why edit was the better tool, but only after a rewrite', async () => {
    file('a.ts', 'one\ntwo\n');
    await run('read', { path: 'a.ts' });

    const rewrote = await run('write', { path: 'a.ts', content: 'one\nTWO\n' });
    const read = await run('read', { path: 'a.ts' });

    expect(rewrote.text).toContain('Use edit to change part of one');
    expect(read.text).not.toContain('Use edit');
  });

  it('keeps everything it tells the model above the diff', async () => {
    file('a.ts', 'one\ntwo\nthree\n');
    await run('read', { path: 'a.ts' });

    const { text } = await run('edit', { path: 'a.ts', oldString: 'two', newString: 'TWO' });
    const lines = text.split('\n');

    // The pane shows the diff and drops what comes before it, so nothing the
    // model is told may appear after the first hunk header.
    const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
    expect(firstHunk).toBeGreaterThan(0);
    expect(lines.slice(firstHunk).some((line) => line.includes('do not repeat'))).toBe(false);
  });
});

describe('bash', () => {
  /** Everything the pane would show for the call: the output, and only that. */
  const output = (text: string): string => text.slice(text.indexOf(OUTPUT_SEPARATOR));

  it('runs the command in the working folder', async () => {
    const { text } = await run('bash', { command: 'echo hi > made.txt && echo done' });

    expect(readFileSync(join(dir, 'made.txt'), 'utf8')).toBe('hi\n');
    expect(text).toContain('done');
  });

  it('reports what the command printed on either stream', async () => {
    const { text, summary } = await run('bash', { command: 'echo out; echo err >&2' });

    expect(text).toContain('out');
    expect(text).toContain('err');
    expect(summary).toBe('2 lines');
  });

  it('reports a non-zero exit rather than failing the call', async () => {
    const { text, summary } = await run('bash', { command: 'echo nope >&2; exit 3' });

    expect(summary).toBe('exit 3');
    expect(text).toContain('Exit status 3');
    expect(text).toContain('nope');
  });

  it('says so when the command printed nothing', async () => {
    const { text, summary } = await run('bash', { command: 'true' });

    expect(summary).toBe('no output');
    expect(text).toContain('No output.');
  });

  // Nothing can be typed in, so a command that stops to ask a question has to
  // end now rather than hold the turn until the timeout.
  it('gives a command that waits for input an immediate end of it', async () => {
    // It ends on the spot with the status a failed read has, rather than
    // sitting there until this test's own timeout runs out.
    const { summary } = await run('bash', { command: 'read -r answer' });

    expect(summary).toBe('exit 1');
  });

  it('kills a command that runs past its timeout', async () => {
    const { text, summary } = await run('bash', { command: 'sleep 30', timeoutMs: 1000 });

    expect(summary).toBe('timed out');
    expect(text).toContain('Timed out after 1s');
  });

  // The command at the top of a hung build is never the one still running: it
  // is a child two levels down, which a kill aimed at the shell would leave.
  it('kills what the command started as well', async () => {
    await run('bash', {
      command: '(sleep 1; echo late > late.txt) & sleep 30',
      timeoutMs: 1000
    });
    await new Promise((done) => setTimeout(done, 2000));

    expect(existsSync(join(dir, 'late.txt'))).toBe(false);
  }, 10_000);

  it('stops the command when the turn is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const { summary } = await runAgentTool(
      'bash',
      JSON.stringify({ command: 'sleep 30' }),
      ctx('thread-1', controller.signal)
    );

    expect(summary).toBe('stopped');
  });

  it('cuts oversized output from the middle and says how much', async () => {
    const { text } = await run('bash', { command: 'yes x | head -c 40000' });

    expect(text).toContain('characters cut from the middle');
    expect(output(text).length).toBeLessThan(31_000);
  });

  it('takes a timeout in milliseconds and refuses one in seconds', async () => {
    await expect(run('bash', { command: 'true', timeoutMs: 30 })).rejects.toThrow(/timeoutMs/);
  });
});

describe('what a command tells the model', () => {
  it('names the tool that would have done it better, when there is one', async () => {
    file('a.ts', 'one\n');

    const { text } = await run('bash', { command: 'cat a.ts | grep one' });

    expect(text).toContain('cat → read');
    expect(text).toContain('grep → grep');
  });

  // The failure this has to answer: stdin is closed, so the command ends in
  // milliseconds with an error and the model is left holding it.
  it('points a command that wanted a terminal at the user', async () => {
    const { text } = await run('bash', {
      command: 'echo "sudo: a terminal is required to read the password" >&2; exit 1'
    });

    expect(text).toContain('Hand it to the user with the terminal tool');
    expect(text.indexOf('Hand it to the user')).toBeLessThan(text.indexOf(OUTPUT_SEPARATOR));
  });

  it('says nothing about terminals to a command that failed on its own merits', async () => {
    const { text } = await run('bash', { command: 'echo "no such file" >&2; exit 2' });

    expect(text).not.toContain('terminal tool');
  });

  it('says nothing when the shell was the right answer', async () => {
    const { text } = await run('bash', { command: 'git status --short' });

    expect(text).not.toContain('long way round');
  });

  // The pane shows what follows the separator, so a note written for the model
  // has to stay above it - the same rule the diff follows.
  it('keeps everything it tells the model above the output', async () => {
    file('a.ts', 'one\n');

    const { text } = await run('bash', { command: 'cat a.ts' });

    expect(text.indexOf('cat → read')).toBeLessThan(text.indexOf(OUTPUT_SEPARATOR));
  });
});

describe('terminal', () => {
  it('hands the command over and says it has not run', async () => {
    const { text, summary } = await run('terminal', { command: 'gh auth login' });

    expect(handedOff).toEqual(['gh auth login']);
    expect(summary).toBe('waiting on you');
    expect(text).toContain('waiting for the user to press Enter');
  });

  // It is typed at a prompt, so a second line would run the first one.
  it('refuses a command written across several lines', async () => {
    await expect(run('terminal', { command: 'gh auth login\nrm -rf /' })).rejects.toThrow(
      /one line/
    );
    expect(handedOff).toEqual([]);
  });

  /*
   * A carriage return is not a character a terminal displays - it is the Enter
   * key, as far as the tty is concerned. Blocking `\n` alone left the one thing
   * this tool promises never to do one character away.
   */
  it('refuses a command carrying any control character', async () => {
    for (const command of ['sudo rm -rf ~\r', 'echo a\x07b', 'echo a\x1b[2Jb']) {
      await expect(run('terminal', { command })).rejects.toThrow(/one line/);
    }
    expect(handedOff).toEqual([]);
  });

  it('will not hand over a command the user already turned down', async () => {
    refused.push('sudo rm -rf /');

    const { text, summary } = await run('terminal', { command: 'sudo rm -rf /' });

    expect(handedOff).toEqual([]);
    expect(summary).toBe('not allowed');
    expect(text).toContain('already turned this command down');
  });
});
