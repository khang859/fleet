import { describe, expect, it } from 'vitest';
import { runPreflight, type Probe } from '../preflight';

function probeOf(answers: Record<string, { code: number; stdout: string } | null>): {
  probe: Probe;
  calls: string[];
} {
  const calls: string[] = [];
  const probe: Probe = async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    return Promise.resolve(answers[key] ?? null);
  };
  return { probe, calls };
}

describe('runPreflight', () => {
  it('reports each tool with its version, and the gh login by exit code', async () => {
    const { probe } = probeOf({
      'claude --version': { code: 0, stdout: '2.1.4 (Claude Code)' },
      'eva --version': { code: 0, stdout: 'eva v0.9' },
      'gh --version': { code: 0, stdout: 'gh version 2.62.0 (2026-09-01)' },
      'gh auth status': { code: 0, stdout: '' }
    });
    expect(await runPreflight({ hasModelKey: () => true, probe })).toEqual({
      modelKey: true,
      claude: { found: true, version: '2.1.4' },
      eva: { found: true, version: '0.9' },
      gh: { found: true, signedIn: true }
    });
  });

  it('reports what is missing, and never asks gh about a login it cannot have', async () => {
    const { probe, calls } = probeOf({
      'claude --version': { code: 127, stdout: '' }
    });
    expect(await runPreflight({ hasModelKey: () => false, probe })).toEqual({
      modelKey: false,
      claude: { found: false, version: null },
      eva: { found: false, version: null },
      gh: { found: false, signedIn: false }
    });
    expect(calls).not.toContain('gh auth status');
  });

  it('reports gh signed out when auth status fails', async () => {
    const { probe } = probeOf({
      'gh --version': { code: 0, stdout: 'gh version 2.62.0' },
      'gh auth status': { code: 1, stdout: '' }
    });
    const result = await runPreflight({ hasModelKey: () => true, probe });
    expect(result.gh).toEqual({ found: true, signedIn: false });
  });
});
