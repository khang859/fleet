import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readConfig,
  writeConfig,
  resolveObjectKey,
  resolveBucketRegion,
  findNearestConfig,
  invalidateConfigCache,
  mostSpecificInjectTarget
} from '../env-sync/env-sync-config';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'envcfg-'));
}

beforeEach(() => invalidateConfigCache());

describe('writeConfig/readConfig', () => {
  it('round-trips a config', () => {
    const dir = makeRepo();
    writeConfig(dir, {
      version: 1,
      id: 'app',
      bucket: 'b',
      region: 'us-east-1',
      targets: [{ envFile: '.env', delivery: 'file' }]
    });
    const cfg = readConfig(dir);
    expect(cfg?.id).toBe('app');
    expect(cfg?.targets[0].envFile).toBe('.env');
  });

  it('returns null when no config exists', () => {
    expect(readConfig(makeRepo())).toBeNull();
  });
});

describe('resolveObjectKey', () => {
  it('defaults to `${id}/${envFile}.enc`', () => {
    const key = resolveObjectKey(
      { version: 1, id: 'app', bucket: 'b', region: 'r', targets: [] },
      { envFile: 'apps/web/.env.production', delivery: 'file' }
    );
    expect(key).toBe('app/apps/web/.env.production.enc');
  });

  it('honors an explicit objectKey', () => {
    const key = resolveObjectKey(
      { version: 1, id: 'app', bucket: 'b', region: 'r', targets: [] },
      { envFile: '.env', delivery: 'file', objectKey: 'custom.enc' }
    );
    expect(key).toBe('custom.enc');
  });
});

describe('resolveBucketRegion', () => {
  it('uses target overrides then repo defaults', () => {
    const cfg = { version: 1 as const, id: 'a', bucket: 'repo-b', region: 'repo-r', targets: [] };
    expect(resolveBucketRegion(cfg, { envFile: '.env', delivery: 'file' })).toEqual({
      bucket: 'repo-b',
      region: 'repo-r'
    });
    expect(
      resolveBucketRegion(cfg, { envFile: '.env', delivery: 'file', bucket: 'tb', region: 'tr' })
    ).toEqual({ bucket: 'tb', region: 'tr' });
  });
});

describe('findNearestConfig', () => {
  it('walks up to the nearest .fleet/env-sync.json', () => {
    const root = makeRepo();
    writeConfig(root, { version: 1, id: 'root', bucket: 'b', region: 'r', targets: [] });
    const deep = join(root, 'apps', 'web', 'src');
    mkdirSync(deep, { recursive: true });
    const found = findNearestConfig(deep);
    expect(found?.config.id).toBe('root');
  });

  it('prefers the inner config for a nested repo', () => {
    const root = makeRepo();
    writeConfig(root, { version: 1, id: 'outer', bucket: 'b', region: 'r', targets: [] });
    const inner = join(root, 'packages', 'inner');
    mkdirSync(inner, { recursive: true });
    writeConfig(inner, { version: 1, id: 'inner', bucket: 'b', region: 'r', targets: [] });
    expect(findNearestConfig(join(inner, 'src'))?.config.id).toBe('inner');
  });
});

describe('mostSpecificInjectTarget', () => {
  it('picks the inject target whose dir is the longest prefix of cwd', () => {
    const cfg = {
      version: 1 as const,
      id: 'a',
      bucket: 'b',
      region: 'r',
      targets: [
        { envFile: '.env', delivery: 'inject' as const },
        { envFile: 'apps/web/.env', delivery: 'inject' as const }
      ]
    };
    const t = mostSpecificInjectTarget('/repo', cfg, '/repo/apps/web/src');
    expect(t?.envFile).toBe('apps/web/.env');
  });
});
