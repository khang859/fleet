import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { missingAgents } from '../worktree-agents';

vi.mock('../shell-env', () => ({ enrichProcessEnv: async (): Promise<void> => {} }));

describe('missingAgents', () => {
  let first: string;
  let second: string;

  beforeEach(() => {
    first = mkdtempSync(join(tmpdir(), 'fleet-agents-'));
    second = mkdtempSync(join(tmpdir(), 'fleet-agents-'));
  });

  afterEach(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  const env = (): NodeJS.ProcessEnv => ({
    PATH: [first, second].join(delimiter),
    PATHEXT: '.EXE;.CMD;'
  });

  it('lists every agent when none is on PATH', async () => {
    expect(await missingAgents('posix', env())).toEqual(['claude', 'pi']);
  });

  it('lists only the agent that is on no PATH folder', async () => {
    writeFileSync(join(second, 'claude'), '');

    expect(await missingAgents('posix', env())).toEqual(['pi']);
  });

  it('lists none when all are found', async () => {
    writeFileSync(join(first, 'claude'), '');
    writeFileSync(join(second, 'pi'), '');

    expect(await missingAgents(undefined, env())).toEqual([]);
  });

  it('says nothing about a WSL distro, which has its own PATH', async () => {
    expect(await missingAgents({ kind: 'wsl', distro: 'Ubuntu' }, env())).toEqual([]);
  });
});
