import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchMentionFiles } from '../mention-search';

/**
 * What the `@` menu offers.
 *
 * The property that matters most is not the ranking: it is that this walk is
 * the same one the tools use, so the menu can never offer a file the sandbox
 * would then refuse to read.
 */

let dir: string;

function file(rel: string, contents = 'x'): void {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

const rels = async (query: string): Promise<string[]> =>
  (await searchMentionFiles(query, dir)).map((m) => m.rel);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-mention-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('searchMentionFiles', () => {
  it('offers everything it can see for a bare @', async () => {
    file('a.ts');
    file('src/b.ts');

    expect(await rels('')).toEqual(['a.ts', 'src/b.ts']);
  });

  it('gives an absolute path to open and a relative one to show', async () => {
    file('src/b.ts');

    expect(await searchMentionFiles('b', dir)).toEqual([
      { path: join(dir, 'src', 'b.ts'), rel: 'src/b.ts' }
    ]);
  });

  it('matches anywhere in the path, not only at the start of a name', async () => {
    file('src/agent/read.ts');

    expect(await rels('ead')).toEqual(['src/agent/read.ts']);
    expect(await rels('agent/re')).toEqual(['src/agent/read.ts']);
  });

  it('ignores case, since nobody types the capital letters', async () => {
    file('src/AgentThread.tsx');

    expect(await rels('agentthread')).toEqual(['src/AgentThread.tsx']);
  });

  /*
   * The one ranking rule. A query is nearly always a filename, so a file called
   * `read.ts` has to come before every file that merely lives in a folder
   * called `read` - otherwise the thing the user typed is off the bottom of a
   * twenty-row menu.
   */
  it('puts a match in the file’s own name above one in its folders', async () => {
    file('read/one.ts');
    file('read/two.ts');
    file('src/read.ts');

    expect(await rels('read')).toEqual(['src/read.ts', 'read/one.ts', 'read/two.ts']);
  });

  it('offers nothing when nothing matches', async () => {
    file('a.ts');

    expect(await rels('nothing-like-this')).toEqual([]);
  });

  // Folders are not attachable: one handed over whole is a hundred files the
  // user did not choose, and every one of them is context they pay for.
  it('offers files and never folders', async () => {
    mkdirSync(join(dir, 'reader'), { recursive: true });
    file('reader/x.ts');

    expect(await rels('reader')).toEqual(['reader/x.ts']);
  });

  // The same walk the tools use, so the menu and the sandbox agree.
  it('leaves out what git was told to forget', async () => {
    file('.gitignore', 'secrets/\n*.log\n');
    file('secrets/token.ts');
    file('build.log');
    file('build.ts');

    expect(await rels('')).toEqual(['.gitignore', 'build.ts']);
  });

  it('never offers a file whose name says it holds a secret', async () => {
    file('.env');
    file('id_rsa');
    file('key.pem');
    file('app.ts');

    expect(await rels('')).toEqual(['app.ts']);
  });

  it('stops at a screenful rather than reading out the whole repository', async () => {
    for (let i = 0; i < 40; i++) file(`file-${String(i).padStart(2, '0')}.ts`);

    expect(await rels('file')).toHaveLength(20);
  });
});
