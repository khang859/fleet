import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { buildDiff, planWrite, planEdit, applyWrite } from '../write-tools';
import { assertWritablePath } from '../fs-safety';

const ROOT = join(tmpdir(), `fleet-write-tools-${process.pid}`);

beforeEach(() => mkdirSync(ROOT, { recursive: true }));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('buildDiff', () => {
  it('prefixes removed and added lines', () => {
    expect(buildDiff('old', 'new')).toBe('- old\n+ new');
  });
  it('caps very large diffs', () => {
    const big = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
    expect(buildDiff('', big)).toMatch(/more lines/);
  });
});

describe('planWrite', () => {
  it('marks a new file and diffs against empty', () => {
    const p = planWrite(join(ROOT, 'new.txt'), 'hello');
    expect(p.isNew).toBe(true);
    expect(p.diff).toBe('+ hello');
  });
  it('diffs against existing content on overwrite', () => {
    const f = join(ROOT, 'a.txt');
    writeFileSync(f, 'before');
    const p = planWrite(f, 'after');
    expect(p.isNew).toBe(false);
    expect(p.diff).toBe('- before\n+ after');
  });
});

describe('planEdit', () => {
  it('replaces a unique occurrence', () => {
    const f = join(ROOT, 'b.ts');
    writeFileSync(f, 'const x = 1;\nconst y = 2;\n');
    const p = planEdit(f, 'const y = 2;', 'const y = 3;');
    expect(p.newContent).toBe('const x = 1;\nconst y = 3;\n');
  });
  it('throws when old_string is missing', () => {
    const f = join(ROOT, 'c.ts');
    writeFileSync(f, 'abc');
    expect(() => planEdit(f, 'zzz', 'q')).toThrow(/not found/);
  });
  it('throws when old_string is not unique', () => {
    const f = join(ROOT, 'd.ts');
    writeFileSync(f, 'x\nx\n');
    expect(() => planEdit(f, 'x', 'y')).toThrow(/not unique/);
  });
});

describe('applyWrite', () => {
  it('creates parent directories', () => {
    const f = join(ROOT, 'deep', 'nested', 'f.txt');
    applyWrite(f, 'hi');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hi');
  });
});

describe('assertWritablePath', () => {
  it('allows a path inside the workspace', () => {
    expect(assertWritablePath('src/a.ts', ROOT, [ROOT])).toContain('a.ts');
  });
  it('blocks writes outside the workspace', () => {
    expect(() => assertWritablePath('/etc/passwd', ROOT, [ROOT])).toThrow(/outside/);
  });
  it('blocks .git internals (circuit-breaker)', () => {
    expect(() => assertWritablePath('.git/config', ROOT, [ROOT])).toThrow(/\.git/);
  });
  it('blocks credential files', () => {
    expect(() =>
      assertWritablePath(join(homedir(), '.ssh', 'authorized_keys'), ROOT, [ROOT])
    ).toThrow();
  });
});
