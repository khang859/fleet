import { describe, it, expect } from 'vitest';
import { findCandidatePaths, type PathCandidate } from '../terminal-path-detect';

/** The common case: one candidate per line, checked for text and suffix only. */
function one(lineText: string): { text: string; line?: number; col?: number } | null {
  const found = findCandidatePaths(lineText);
  if (found.length !== 1) return null;
  const { text, line, col } = found[0];
  return { text, ...(line !== undefined ? { line } : {}), ...(col !== undefined ? { col } : {}) };
}

describe('findCandidatePaths: shapes that should match', () => {
  it('absolute posix path', () => {
    expect(one('/home/khang/project/src/index.ts')).toEqual({
      text: '/home/khang/project/src/index.ts'
    });
  });
  it('windows drive path with backslashes', () => {
    expect(one('C:\\Users\\khang\\index.ts')).toEqual({ text: 'C:\\Users\\khang\\index.ts' });
  });
  it('windows drive path with forward slashes', () => {
    expect(one('C:/Users/khang/index.ts')).toEqual({ text: 'C:/Users/khang/index.ts' });
  });
  it('lowercase drive letter', () => {
    expect(one('d:/projects/foo.rs')).toEqual({ text: 'd:/projects/foo.rs' });
  });
  it('dot-relative path', () => {
    expect(one('./src/index.ts')).toEqual({ text: './src/index.ts' });
  });
  it('parent-relative path', () => {
    expect(one('../lib/util.ts')).toEqual({ text: '../lib/util.ts' });
  });
  it('repeated parent segments', () => {
    expect(one('../../shared/types.ts')).toEqual({ text: '../../shared/types.ts' });
  });
  it('home-relative path', () => {
    expect(one('~/dotfiles/.zshrc')).toEqual({ text: '~/dotfiles/.zshrc' });
  });
  it('bare relative path with a slash and an extension', () => {
    expect(one('src/main/index.ts')).toEqual({ text: 'src/main/index.ts' });
  });
  it('relative path with two separators and no extension', () => {
    expect(one('a/b/c')).toEqual({ text: 'a/b/c' });
  });
  it('directory path with a trailing slash', () => {
    expect(one('src/renderer/')).toEqual({ text: 'src/renderer/' });
  });
  it('one-segment directory, where the trailing slash is the only evidence', () => {
    expect(one('docs/')).toEqual({ text: 'docs/' });
  });
  it('a trailing slash still has to have something in front of it', () => {
    expect(findCandidatePaths('/ // and / more')).toEqual([]);
  });
  it('path containing a percent-encoded or unusual segment char', () => {
    expect(one('src/a%20b/c.ts')).toEqual({ text: 'src/a%20b/c.ts' });
  });
  it('scoped-package style path with @ and +', () => {
    expect(one('node_modules/@xterm/addon-web-links/src/x.ts')).toEqual({
      text: 'node_modules/@xterm/addon-web-links/src/x.ts'
    });
  });
});

describe('findCandidatePaths: line and column suffixes', () => {
  it('line only', () => {
    expect(one('src/app.ts:42')).toEqual({ text: 'src/app.ts', line: 42 });
  });
  it('line and column', () => {
    expect(one('src/app.ts:42:7')).toEqual({ text: 'src/app.ts', line: 42, col: 7 });
  });
  it('suffix on an absolute path', () => {
    expect(one('/etc/hosts:3')).toEqual({ text: '/etc/hosts', line: 3 });
  });
  it('suffix on a windows drive path leaves the drive colon alone', () => {
    expect(one('C:\\Users\\khang\\a.ts:10')).toEqual({
      text: 'C:\\Users\\khang\\a.ts',
      line: 10
    });
  });
  it('trailing comma after a suffix is not part of it', () => {
    expect(one('src/app.ts:42,')).toEqual({ text: 'src/app.ts', line: 42 });
  });
  it('a tsc-style diagnostic line', () => {
    expect(one('error TS2304 in src/app.ts:15:9')).toEqual({
      text: 'src/app.ts',
      line: 15,
      col: 9
    });
  });
  it('a bare trailing colon is stripped, not read as a line number', () => {
    expect(one('src/app.ts:')).toEqual({ text: 'src/app.ts' });
  });
  it('a trailing colon after a line number is stripped', () => {
    expect(one('src/app.ts:12:')).toEqual({ text: 'src/app.ts', line: 12 });
  });

  // tsc and MSBuild spell it this way, so it turns up constantly in this repo's
  // own typecheck output.
  it('paren form with line and column', () => {
    expect(one('src/app.ts(24,44)')).toEqual({ text: 'src/app.ts', line: 24, col: 44 });
  });
  it('paren form with a line only', () => {
    expect(one('src/app.ts(24)')).toEqual({ text: 'src/app.ts', line: 24 });
  });
  it('paren form inside a real tsc diagnostic', () => {
    expect(one('src/renderer/src/lib/claude-settings-lint.ts(24,44): error TS2353: bad')).toEqual({
      text: 'src/renderer/src/lib/claude-settings-lint.ts',
      line: 24,
      col: 44
    });
  });
  it('paren form nested in enclosing parentheses', () => {
    expect(one('(src/app.ts(24,44))')).toEqual({ text: 'src/app.ts', line: 24, col: 44 });
  });
  it('a lone line-column group is not a path', () => {
    expect(findCandidatePaths('(24,44)')).toEqual([]);
  });
  it('a bare port-like suffix is not a path', () => {
    expect(findCandidatePaths(':8080')).toEqual([]);
  });
});

describe('findCandidatePaths: enclosing punctuation', () => {
  it('parentheses', () => {
    expect(one('(src/a.ts)')).toEqual({ text: 'src/a.ts' });
  });
  it('single quotes with a trailing comma', () => {
    expect(one("'src/a.ts',")).toEqual({ text: 'src/a.ts' });
  });
  it('double quotes', () => {
    expect(one('"src/a.ts"')).toEqual({ text: 'src/a.ts' });
  });
  it('backticks', () => {
    expect(one('`src/a.ts`')).toEqual({ text: 'src/a.ts' });
  });
  it('square brackets', () => {
    expect(one('[src/a.ts]')).toEqual({ text: 'src/a.ts' });
  });
  it('angle brackets', () => {
    expect(one('<src/a.ts>')).toEqual({ text: 'src/a.ts' });
  });
  it('sentence-ending period', () => {
    expect(one('Look at src/a.ts.')).toEqual({ text: 'src/a.ts' });
  });
  it('trailing semicolon', () => {
    expect(one('src/a.ts;')).toEqual({ text: 'src/a.ts' });
  });
  // Claude Code labels almost all of its tool activity this way, which makes it
  // the most common shape a path arrives in.
  it('a tool-call wrapper around a path', () => {
    expect(one('Read(src/main/index.ts)')).toEqual({ text: 'src/main/index.ts' });
  });
  it('a tool-call wrapper with the status glyph Claude Code prints', () => {
    expect(one('● Read(src/main/index.ts)')).toEqual({ text: 'src/main/index.ts' });
  });
  it('a tool-call wrapper reports the offset of the path, not the call', () => {
    const line = '● Edit(src/a.ts)';
    const [found] = findCandidatePaths(line);
    expect(line.slice(found.index, found.index + found.text.length)).toBe('src/a.ts');
  });
  it('a tool-call wrapper around a path carrying a line number', () => {
    expect(one('Read(src/a.ts:12)')).toEqual({ text: 'src/a.ts', line: 12 });
  });
  it('a tool-call wrapper whose argument is not a path', () => {
    expect(findCandidatePaths('Bash(npm run build)')).toEqual([]);
  });
  it('a dotfile keeps its leading dot', () => {
    expect(one('~/.config/nvim/init.lua')).toEqual({ text: '~/.config/nvim/init.lua' });
  });
});

describe('findCandidatePaths: shapes that must not match', () => {
  const rejected = [
    ['a bare filename with no separator', 'index.ts'],
    ['a version string', 'v1.2.3'],
    ['a sentence abbreviation', 'e.g.'],
    ['a product name with a dot', 'Node.js'],
    ['a domain name', 'example.com'],
    ['prose with no separator or prefix', 'all tests passed'],
    ['an either/or word pair', 'and/or'],
    ['an http url', 'https://example.com/a/b.ts'],
    ['an https url with a port', 'https://localhost:3000/src/a.ts'],
    ['a custom scheme url', 'fleet-image:///home/k/a.png'],
    ['a windows UNC path', '\\\\server\\share\\file.txt'],
    ['a UNC path in forward-slash spelling', '//server/share/file.txt'],
    ['a bare separator', '/'],
    ['a doubled separator only', '//'],
    ['an empty line', ''],
    ['whitespace only', '   \t  '],
    ['a backslash-only relative path', 'src\\main\\index.ts'],
    // Every shell prompt sitting in $HOME prints one, so matching it would
    // underline a piece of most prompt lines to reveal a folder the user is
    // already standing in. `~/x` still matches - it carries a separator.
    ['a bare tilde', '~']
  ] as const;

  for (const [label, input] of rejected) {
    it(`rejects ${label}`, () => {
      expect(findCandidatePaths(input)).toEqual([]);
    });
  }
});

describe('findCandidatePaths: offsets and multiple candidates', () => {
  it('reports the offset of the path itself, not the enclosing punctuation', () => {
    const line = 'see (src/a.ts) now';
    const [found] = findCandidatePaths(line);
    expect(found.index).toBe(5);
    expect(line.slice(found.index, found.index + found.text.length)).toBe('src/a.ts');
  });

  it('reports an offset of zero for a path at the start of the line', () => {
    expect(findCandidatePaths('src/a.ts is here')[0].index).toBe(0);
  });

  it('finds two candidates on one line with correct offsets and suffixes', () => {
    const line = 'see src/a.ts and src/b.ts:5 here';
    const found = findCandidatePaths(line);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ text: 'src/a.ts', index: 4 });
    expect(found[1]).toMatchObject({ text: 'src/b.ts', index: 17, line: 5 });
    for (const c of found) {
      expect(line.slice(c.index, c.index + c.text.length)).toBe(c.text);
    }
  });

  it('offsets survive tabs and runs of spaces', () => {
    const line = '\t\tRead   src/main/index.ts';
    const [found] = findCandidatePaths(line);
    expect(line.slice(found.index, found.index + found.text.length)).toBe('src/main/index.ts');
  });

  it('picks the path out of a realistic agent tool line', () => {
    expect(one('  ⎿  Updated src/renderer/src/hooks/use-terminal.ts with 3 additions')).toEqual({
      text: 'src/renderer/src/hooks/use-terminal.ts'
    });
  });

  it('picks the path out of a realistic vitest line', () => {
    expect(one(' ✓ src/shared/__tests__/path-platform.test.ts (42 tests) 15ms')).toEqual({
      text: 'src/shared/__tests__/path-platform.test.ts'
    });
  });
});

describe('bare names, matched against a directory listing', () => {
  const listing = new Set(['package.json', 'src', 'build.sh', 'Makefile', 'README.md']);
  const bare = (line: string): PathCandidate[] => findCandidatePaths(line, listing);

  it('matches a name the directory holds', () => {
    expect(bare('package.json')).toEqual([{ text: 'package.json', index: 0, bare: true }]);
  });

  it('matches a name with no extension', () => {
    expect(bare('Makefile').map((c) => c.text)).toEqual(['Makefile']);
  });

  it('matches every column of an `ls` row', () => {
    expect(bare('Makefile  README.md  package.json  src').map((c) => c.text)).toEqual([
      'Makefile',
      'README.md',
      'package.json',
      'src'
    ]);
  });

  it('leaves a name the directory does not hold', () => {
    expect(bare('Node.js v1.2.3 index.ts either/or')).toEqual([]);
  });

  it('drops the classify suffix of `ls -F` but keeps the offset', () => {
    expect(bare('  build.sh*')).toEqual([{ text: 'build.sh', index: 2, bare: true }]);
  });

  it('honours a position suffix', () => {
    expect(bare('README.md:12:5')).toEqual([
      { text: 'README.md', index: 0, bare: true, line: 12, col: 5 }
    ]);
  });

  it('does not match the directory itself', () => {
    expect(bare('. ..')).toEqual([]);
  });

  it('matches nothing at all without a listing', () => {
    expect(findCandidatePaths('package.json  Makefile')).toEqual([]);
  });

  it('leaves separator paths to the grammar, unmarked', () => {
    expect(bare('src/main/index.ts')).toEqual([{ text: 'src/main/index.ts', index: 0 }]);
  });
});
