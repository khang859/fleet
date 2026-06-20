import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listEnvFiles,
  readEnvFile,
  writeEnvFile,
  createEnvFile,
  renameEnvFile,
  softDeleteEnvFile,
  restoreEnvFile
} from '../env-editor/env-editor-fs';

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

describe('env-editor fs ops', () => {
  it('reads and writes, returning updated content', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    const read = readEnvFile(p);
    expect(read.text).toBe('A=1\n');
    const res = writeEnvFile(p, 'A=2\n');
    expect(res.ok).toBe(true);
    expect(readEnvFile(p).text).toBe('A=2\n');
  });

  it('detects external change via mtime', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    const stale = readEnvFile(p).mtimeMs - 1000;
    writeFileSync(p, 'A=changed\n'); // simulate external edit (newer mtime)
    const res = writeEnvFile(p, 'A=2\n', stale);
    expect(res.ok).toBe(false);
    expect(res.externalChange).toBe(true);
  });

  it('returns missingDir instead of throwing when the parent folder is gone', () => {
    // Simulate a folder that was renamed/deleted out from under a stale path.
    const goneDir = join(root, 'renamed-away');
    const p = join(goneDir, '.env');
    const res = writeEnvFile(p, 'A=2\n');
    expect(res.ok).toBe(false);
    expect(res.missingDir).toBe(true);
  });

  it('creates a file, rejecting non-.env names and collisions', () => {
    const { absPath } = createEnvFile(root, '.env.local');
    expect(existsSync(absPath)).toBe(true);
    expect(() => createEnvFile(root, 'notenv')).toThrow();
    expect(() => createEnvFile(root, '.env.local')).toThrow();
  });

  it('renames with collision protection', () => {
    const a = join(root, '.env');
    writeFileSync(a, 'A=1\n');
    const { absPath } = renameEnvFile(a, '.env.bak');
    expect(basename(absPath)).toBe('.env.bak');
    expect(existsSync(a)).toBe(false);
  });

  it('rejects file names containing path separators', () => {
    expect(() => createEnvFile(root, '.env/../evil')).toThrow();
    expect(() => createEnvFile(root, '.env/local')).toThrow();
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    expect(() => renameEnvFile(p, '.env/../evil')).toThrow();
  });

  it('soft-deletes and restores', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    const { trashPath } = softDeleteEnvFile(p);
    expect(existsSync(p)).toBe(false);
    restoreEnvFile(trashPath, p);
    expect(readEnvFile(p).text).toBe('A=1\n');
  });
});
