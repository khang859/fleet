import { describe, it, expect } from 'vitest';
import { EnvSyncConfigSchema, EnvSyncTargetSchema } from '../env-sync-types';

describe('EnvSyncTargetSchema', () => {
  it('defaults delivery to "file"', () => {
    const t = EnvSyncTargetSchema.parse({ envFile: '.env' });
    expect(t.delivery).toBe('file');
  });

  it('accepts inject + overrides', () => {
    const t = EnvSyncTargetSchema.parse({
      envFile: 'apps/api/.env',
      delivery: 'inject',
      objectKey: 'custom/api.env.enc',
      bucket: 'other'
    });
    expect(t).toMatchObject({
      delivery: 'inject',
      objectKey: 'custom/api.env.enc',
      bucket: 'other'
    });
  });
});

describe('EnvSyncConfigSchema', () => {
  it('parses a valid config and defaults targets to []', () => {
    const c = EnvSyncConfigSchema.parse({
      version: 1,
      id: 'my-app',
      bucket: 'b',
      region: 'us-east-1'
    });
    expect(c.targets).toEqual([]);
  });

  it('rejects missing id', () => {
    expect(() =>
      EnvSyncConfigSchema.parse({ version: 1, bucket: 'b', region: 'us-east-1' })
    ).toThrow();
  });
});
