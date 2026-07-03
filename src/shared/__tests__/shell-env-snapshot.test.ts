import { describe, it, expect } from 'vitest';
import { buildEnvSnapshot } from '../shell-env-snapshot';

describe('buildEnvSnapshot', () => {
  it('tags sources, defaults to login-shell, and forces FLEET_SESSION to fleet-builtin', () => {
    const snap = buildEnvSnapshot({
      finalEnv: {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/cfg',
        MY_SECRET: 'abc',
        FLEET_SESSION: '1'
      },
      sources: { CLAUDE_CONFIG_DIR: 'fleet-builtin', MY_SECRET: 'env-sync' },
      shellName: 'zsh',
      cwd: '/repo',
      spawnedAt: 1000
    });

    expect(snap.spawnedAt).toBe(1000);
    expect(snap.shellName).toBe('zsh');
    expect(snap.cwd).toBe('/repo');
    // sorted ascending by key
    expect(snap.vars.map((v) => v.key)).toEqual([
      'CLAUDE_CONFIG_DIR',
      'FLEET_SESSION',
      'MY_SECRET',
      'PATH'
    ]);
    expect(snap.vars.find((v) => v.key === 'PATH')?.source).toBe('login-shell');
    expect(snap.vars.find((v) => v.key === 'CLAUDE_CONFIG_DIR')?.source).toBe('fleet-builtin');
    expect(snap.vars.find((v) => v.key === 'MY_SECRET')?.source).toBe('env-sync');
    expect(snap.vars.find((v) => v.key === 'FLEET_SESSION')?.source).toBe('fleet-builtin');
  });

  it('drops keys whose value is undefined', () => {
    const snap = buildEnvSnapshot({
      finalEnv: { A: 'x', B: undefined },
      sources: {},
      shellName: 'bash',
      cwd: '/',
      spawnedAt: 0
    });
    expect(snap.vars.map((v) => v.key)).toEqual(['A']);
  });
});
