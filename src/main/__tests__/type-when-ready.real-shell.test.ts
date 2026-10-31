import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { typeWhenReady } from '../pty-manager';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await delay(100);
}

describe.skipIf(process.platform === 'win32')('typeWhenReady in a real shell', () => {
  let dir: string;
  let shell: IPty;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-type-'));
    shell = spawn('/bin/bash', ['--noprofile', '--norc'], { cwd: dir });
  });

  afterEach(() => {
    shell.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the agent line away from a setup that reads stdin', async () => {
    const answer = join(dir, 'answer');
    const agentRan = join(dir, 'agent-ran');

    typeWhenReady(shell, 'head -n 1 > answer\ntouch agent-ran');

    await waitForFile(answer);
    await delay(1500);
    expect(existsSync(agentRan)).toBe(false);

    shell.write('yes\r');
    await waitForFile(agentRan);

    expect(existsSync(agentRan)).toBe(true);
    expect(readFileSync(answer, 'utf8').trim()).toBe('yes');
  }, 20_000);
});
