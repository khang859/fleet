import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiAuthInspector } from '../pi-auth-inspector';

function makeDir(): string {
  const d = join(
    tmpdir(),
    `fleet-pi-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(d, { recursive: true });
  return d;
}

describe('PiAuthInspector.getBuiltInStatus', () => {
  let dir: string;
  const realEnv = { ...process.env };

  beforeEach(() => {
    dir = makeDir();
    for (const k of Object.keys(process.env)) {
      if (
        k.endsWith('_API_KEY') ||
        k.startsWith('AWS_') ||
        k.startsWith('GOOGLE_') ||
        k.startsWith('AZURE_') ||
        k === 'HF_TOKEN'
      ) {
        delete process.env[k];
      }
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...realEnv };
  });

  it('marks all providers as Not configured when no auth and no env', async () => {
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    for (const p of list) {
      expect(p.authenticated).toBe(false);
      expect(p.method).toBe('none');
    }
  });

  it('detects env-var-based auth', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    const anthropic = list.find((p) => p.id === 'anthropic');
    expect(anthropic?.authenticated).toBe(true);
    expect(anthropic?.method).toBe('env-var');
    expect(anthropic?.envVarName).toBe('ANTHROPIC_API_KEY');
  });

  it('detects OAuth-based auth from auth.json', async () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: { oauth: { access_token: 'tok', expires_at: Date.now() + 3600_000 } }
      })
    );
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    const anthropic = list.find((p) => p.id === 'anthropic');
    expect(anthropic?.authenticated).toBe(true);
    expect(anthropic?.method).toBe('oauth');
  });

  it('falls back to Not configured when auth.json is unreadable', async () => {
    writeFileSync(join(dir, 'auth.json'), 'not json');
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    expect(list.every((p) => !p.authenticated || p.method === 'env-var')).toBe(true);
  });
});
