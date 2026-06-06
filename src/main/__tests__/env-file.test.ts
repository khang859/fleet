import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, diffEnv, hashPlaintext, maskValue, scanCandidates } from '../env-sync/env-file';

describe('parseEnv', () => {
  it('parses keys, ignores comments/blank, handles export + quotes', () => {
    const { map } = parseEnv('# c\n\nexport A=1\nB="two words"\nC=\n');
    expect(map).toEqual({ A: '1', B: 'two words', C: '' });
  });
});

describe('maskValue', () => {
  it('masks all but the last 2 chars', () => {
    expect(maskValue('abcdef')).toBe('••••ef');
    expect(maskValue('a')).toBe('•');
  });
});

describe('diffEnv', () => {
  it('detects added/removed/changed/unchanged with masked values', () => {
    const d = diffEnv('A=1\nB=keep\nC=old', 'A=1\nB=keep\nD=new');
    const byKey = Object.fromEntries(d.entries.map((e) => [e.key, e.change]));
    expect(byKey).toEqual({ A: 'unchanged', B: 'unchanged', C: 'removed', D: 'added' });
  });

  it('marks a value change', () => {
    const d = diffEnv('A=old', 'A=new');
    expect(d.entries.find((e) => e.key === 'A')?.change).toBe('changed');
  });
});

describe('hashPlaintext', () => {
  it('is stable and content-sensitive', () => {
    expect(hashPlaintext('X=1')).toBe(hashPlaintext('X=1'));
    expect(hashPlaintext('X=1')).not.toBe(hashPlaintext('X=2'));
  });
});

describe('scanCandidates', () => {
  it('finds env files and excludes templates + node_modules + build dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envscan-'));
    writeFileSync(join(dir, '.env'), 'A=1');
    writeFileSync(join(dir, '.env.local'), 'A=1');
    writeFileSync(join(dir, '.env.example'), 'A=');
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', '.env.production'), 'A=1');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', '.env'), 'A=1');

    const found = scanCandidates(dir).sort();
    expect(found).toEqual(['.env', '.env.local', 'apps/web/.env.production']);
  });
});
