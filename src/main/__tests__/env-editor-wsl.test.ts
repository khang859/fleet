import { describe, it, expect } from 'vitest';
import { listEnvFilesWsl, buildFindArgs } from '../env-editor/env-editor-wsl';
import { toWslUncPath } from '../../shared/path-platform';
import type { ExecResult } from '../run-in-context';

const ctx = { kind: 'wsl' as const, distro: 'Ubuntu' };
const root = '/home/k/proj';

// Async thunks (with a real await) so lint's promise-function-async / require-await
// stay happy while the returned function is still injectable as a Dep.
function resolves<T>(value: T): () => Promise<T> {
  return async () => {
    await Promise.resolve();
    return value;
  };
}
function rejects(err: Error): () => Promise<never> {
  return async () => {
    await Promise.resolve();
    throw err;
  };
}
function execStdout(stdout: string): () => Promise<ExecResult> {
  return resolves<ExecResult>({ stdout, stderr: '', code: 0, timedOut: false });
}

describe('listEnvFilesWsl', () => {
  it('discovers env files in-distro and returns UNC-accessible entries', async () => {
    const files = [`${root}/.env`, `${root}/apps/web/.env`, `${root}/.env.example`];
    const entries = await listEnvFilesWsl(ctx, root, {
      exec: execStdout(files.join('\n') + '\n'),
      read: resolves('A=1\nB=2\n')
    });

    const byRel = new Map(entries.map((e) => [e.relPath, e]));
    expect(byRel.get('.env')!.absPath).toBe(toWslUncPath(ctx.distro, `${root}/.env`));
    expect(byRel.get('.env')!.group).toBe('·root');
    expect(byRel.get('.env')!.varCount).toBe(2);
    expect(byRel.get('.env')!.isTemplate).toBe(false);
    expect(byRel.get('.env')!.readable).toBe(true);
    expect(byRel.get('apps/web/.env')!.absPath).toBe(
      toWslUncPath(ctx.distro, `${root}/apps/web/.env`)
    );
    expect(byRel.get('apps/web/.env')!.group).toBe('apps/web');
    expect(byRel.get('.env.example')!.isTemplate).toBe(true);
  });

  it('sorts ·root group first', async () => {
    const files = [`${root}/pkg/.env`, `${root}/.env`];
    const entries = await listEnvFilesWsl(ctx, root, {
      exec: execStdout(files.join('\n') + '\n'),
      read: resolves('')
    });
    expect(entries[0].group).toBe('·root');
  });

  it('marks a file unreadable when its read fails, without throwing', async () => {
    const entries = await listEnvFilesWsl(ctx, root, {
      exec: execStdout(`${root}/.env\n`),
      read: rejects(new Error('EIO'))
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].readable).toBe(false);
    expect(entries[0].varCount).toBe(0);
  });

  it('returns an empty list when the in-distro find fails (e.g. stopped distro)', async () => {
    const entries = await listEnvFilesWsl(ctx, root, {
      exec: rejects(new Error('spawn wsl.exe ENOENT')),
      read: resolves('')
    });
    expect(entries).toEqual([]);
  });
});

describe('buildFindArgs', () => {
  it('prunes excluded dirs, bounds depth, and matches .env*', () => {
    const args = buildFindArgs(root);
    expect(args[0]).toBe(root);
    expect(args).toContain('-maxdepth');
    expect(args).toContain('node_modules');
    expect(args).toContain('-prune');
    expect(args.slice(-5)).toEqual(['-type', 'f', '-name', '.env*', '-print']);
  });
});
