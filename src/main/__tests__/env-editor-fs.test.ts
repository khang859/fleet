import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listEnvFiles } from '../env-editor/env-editor-fs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'env-editor-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listEnvFiles', () => {
  it('finds nested env files, groups them, and flags templates', () => {
    writeFileSync(join(root, '.env'), 'A=1\nB=2\n');
    writeFileSync(join(root, '.env.example'), 'A=\n');
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', '.env'), 'C=3\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', '.env'), 'IGNORED=1\n');

    const entries = listEnvFiles(root);
    const names = entries.map((e) => e.relPath);
    expect(names).toContain('.env');
    expect(names).toContain('.env.example');
    expect(names).toContain('apps/web/.env');
    expect(names).not.toContain('node_modules/pkg/.env'); // excluded dir

    const rootEnv = entries.find((e) => e.relPath === '.env')!;
    expect(rootEnv.group).toBe('·root');
    expect(rootEnv.varCount).toBe(2);
    expect(rootEnv.isTemplate).toBe(false);

    expect(entries.find((e) => e.relPath === '.env.example')!.isTemplate).toBe(true);
    expect(entries.find((e) => e.relPath === 'apps/web/.env')!.group).toBe('apps/web');
  });

  it('sorts ·root group first', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', '.env'), '');
    writeFileSync(join(root, '.env'), '');
    expect(listEnvFiles(root)[0].group).toBe('·root');
  });
});
