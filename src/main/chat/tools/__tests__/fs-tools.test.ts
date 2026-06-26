import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { globToRegExp, readFileTool, globTool, searchTool } from '../fs-tools';
import { assertReadablePath } from '../fs-safety';

const ROOT = join(tmpdir(), `fleet-fs-tools-${process.pid}`);

beforeAll(() => {
  mkdirSync(join(ROOT, 'src'), { recursive: true });
  mkdirSync(join(ROOT, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ROOT, 'src', 'a.ts'), 'line one\nconst x = 42;\nline three\n');
  writeFileSync(join(ROOT, 'src', 'b.js'), 'const y = 1;\n');
  writeFileSync(join(ROOT, 'readme.md'), '# Title\nhello world\n');
  writeFileSync(join(ROOT, 'node_modules', 'pkg', 'index.js'), 'const x = 99;\n');
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('globToRegExp', () => {
  it('handles *, **, and ?', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false); // * doesn't cross /
    expect(globToRegExp('**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('ac')).toBe(false);
  });
});

describe('readFileTool', () => {
  it('returns numbered lines and honors offset/limit', () => {
    const out = readFileTool({ path: 'src/a.ts', cwd: ROOT });
    expect(out).toContain('1\tline one');
    expect(out).toContain('2\tconst x = 42;');
    const sliced = readFileTool({ path: 'src/a.ts', cwd: ROOT, offset: 1, limit: 1 });
    expect(sliced).toBe('2\tconst x = 42;');
  });
});

describe('globTool', () => {
  it('matches by relative path and skips node_modules', () => {
    const ts = globTool({ pattern: '**/*.ts', cwd: ROOT });
    expect(ts).toContain('src/a.ts');
    const js = globTool({ pattern: '**/*.js', cwd: ROOT });
    expect(js).toContain('src/b.js');
    expect(js).not.toContain('node_modules/pkg/index.js');
  });
});

describe('searchTool', () => {
  it('finds matching lines with file:line and skips node_modules', () => {
    const hits = searchTool({ regex: 'const x', cwd: ROOT });
    expect(hits).toEqual([{ file: 'src/a.ts', line: 2, text: 'const x = 42;' }]);
  });
  it('restricts by glob', () => {
    const hits = searchTool({ regex: 'const', cwd: ROOT, glob: '**/*.js' });
    expect(hits.map((h) => h.file)).toEqual(['src/b.js']);
  });
});

describe('assertReadablePath', () => {
  it('denies credential roots like ~/.ssh and ~/.aws', () => {
    const home = homedir();
    expect(() => assertReadablePath(join(home, '.ssh', 'config'), ROOT)).toThrow(/credential/);
    expect(() => assertReadablePath(join(home, '.aws', 'credentials'), ROOT)).toThrow(/credential/);
  });
  it('denies .env and key files by basename', () => {
    expect(() => assertReadablePath('.env', ROOT)).toThrow(/protected/);
    expect(() => assertReadablePath('config/.env.local', ROOT)).toThrow(/protected/);
    expect(() => assertReadablePath('deploy.pem', ROOT)).toThrow(/protected/);
  });
  it('allows ordinary files', () => {
    expect(assertReadablePath('src/a.ts', ROOT)).toContain('a.ts');
  });
});
