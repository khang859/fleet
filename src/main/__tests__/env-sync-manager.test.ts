// src/main/__tests__/env-sync-manager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvSyncManager } from '../env-sync/env-sync-manager';
import { writeConfig, invalidateConfigCache } from '../env-sync/env-sync-config';
import type { EnvSyncSyncStateData } from '../env-sync/env-sync-manager';

class FakeStateStore {
  data: EnvSyncSyncStateData = {};
  get() { return this.data; }
  set(n: EnvSyncSyncStateData) { this.data = n; }
}

// In-memory S3 keyed by `${bucket}/${key}`; etag derived from a monotonic counter.
function fakeS3() {
  const objs = new Map<string, { body: Buffer; etag: string }>();
  let seq = 0;
  return {
    objs,
    // `_auth` is accepted and ignored — auth resolution is tested in s3-client/secrets specs.
    head: async (b: string, _r: string, k: string, _auth?: unknown) => objs.get(`${b}/${k}`) ? { etag: objs.get(`${b}/${k}`)!.etag } : null,
    get: async (b: string, _r: string, k: string, _auth?: unknown) => { const o = objs.get(`${b}/${k}`)!; return { body: o.body, etag: o.etag }; },
    put: async (b: string, _r: string, k: string, body: Buffer, _auth?: unknown, ifMatch?: string) => {
      const cur = objs.get(`${b}/${k}`);
      if (ifMatch && cur && cur.etag !== ifMatch) { const e = new Error('precondition'); (e as { name?: string }).name = 'PreconditionFailed'; throw e; }
      const etag = `"e${++seq}"`;
      objs.set(`${b}/${k}`, { body, etag });
      return { etag };
    },
    isPreconditionFailed: (err: unknown) => (err as { name?: string })?.name === 'PreconditionFailed',
    isConditionalConflict: (err: unknown) => (err as { name?: string })?.name === 'ConditionalRequestConflict'
  };
}

// Identity "crypto" so the stored body is the plaintext (encryption tested separately).
const fakeCrypto = {
  encrypt: async (pt: Buffer) => pt,
  decrypt: async (blob: Buffer) => blob
};

const fakeSecrets = {
  resolvePassphrase: () => 'pw',
  resolveAuth: () => ({ mode: 'default-chain' as const })
};

function makeRepo(targets: Array<{ envFile: string; delivery?: 'file' | 'inject' }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'envmgr-'));
  writeConfig(dir, { version: 1, id: 'app', bucket: 'b', region: 'r', targets: targets.map((t) => ({ envFile: t.envFile, delivery: t.delivery ?? 'file' })) });
  return dir;
}

function make(s3 = fakeS3()) {
  const mgr = new EnvSyncManager({
    s3, crypto: fakeCrypto, secrets: fakeSecrets, store: new FakeStateStore()
  });
  return { mgr, s3 };
}

beforeEach(() => invalidateConfigCache());

describe('EnvSyncManager.status', () => {
  it('reports local-only when there is a local file but no remote', async () => {
    const dir = makeRepo([{ envFile: '.env' }]);
    writeFileSync(join(dir, '.env'), 'A=1');
    const { mgr } = make();
    const st = await mgr.status(dir);
    expect(st[0].state).toBe('local-only');
  });

  it('reports in-sync after a push', async () => {
    const dir = makeRepo([{ envFile: '.env' }]);
    writeFileSync(join(dir, '.env'), 'A=1');
    const { mgr } = make();
    await mgr.push(dir, dir, '.env');
    expect((await mgr.status(dir))[0].state).toBe('in-sync');
  });
});

describe('EnvSyncManager.pull', () => {
  it('writes the .env file for file delivery', async () => {
    const dir = makeRepo([{ envFile: '.env' }]);
    writeFileSync(join(dir, '.env'), 'A=1');
    const { mgr, s3 } = make();
    await mgr.push(dir, dir, '.env');
    // Simulate remote-ahead: change remote out from under us.
    const key = 'app/.env.enc';
    s3.objs.set(`b/${key}`, { body: Buffer.from('A=2'), etag: '"remote2"' });
    const out = await mgr.pull(dir, dir, '.env', { force: true });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('A=2');
  });

  it('returns a conflict diff when both sides changed', async () => {
    const dir = makeRepo([{ envFile: '.env' }]);
    writeFileSync(join(dir, '.env'), 'A=1');
    const { mgr, s3 } = make();
    await mgr.push(dir, dir, '.env');
    writeFileSync(join(dir, '.env'), 'A=local'); // local change
    s3.objs.set('b/app/.env.enc', { body: Buffer.from('A=remote'), etag: '"r9"' }); // remote change
    const out = await mgr.pull(dir, dir, '.env', { force: false });
    expect(out).toMatchObject({ ok: false, conflict: true });
  });
});

describe('EnvSyncManager.push conflict', () => {
  it('detects a conflicting remote via precondition', async () => {
    const dir = makeRepo([{ envFile: '.env' }]);
    writeFileSync(join(dir, '.env'), 'A=1');
    const { mgr, s3 } = make();
    await mgr.push(dir, dir, '.env');
    s3.objs.set('b/app/.env.enc', { body: Buffer.from('A=x'), etag: '"moved"' }); // remote moved
    writeFileSync(join(dir, '.env'), 'A=2');
    const out = await mgr.push(dir, dir, '.env', { force: false });
    expect(out).toMatchObject({ ok: false, conflict: true });
  });
});

describe('EnvSyncManager.getEnvForCwd', () => {
  it('returns decrypted vars for the most-specific inject target', async () => {
    const dir = makeRepo([{ envFile: '.env', delivery: 'inject' }]);
    writeFileSync(join(dir, '.env'), 'A=1\nB=2');
    const { mgr } = make();
    await mgr.push(dir, dir, '.env');
    const env = await mgr.getEnvForCwd(join(dir, 'sub'));
    expect(env).toEqual({ A: '1', B: '2' });
  });

  it('returns {} when no inject target matches', async () => {
    const dir = makeRepo([{ envFile: '.env', delivery: 'file' }]);
    const { mgr } = make();
    expect(await mgr.getEnvForCwd(join(dir, 'sub'))).toEqual({});
  });
});
