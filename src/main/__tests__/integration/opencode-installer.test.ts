import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { install, uninstall, status } from '../../integration/opencode-installer';

let home: string;

function ensureFleetBin(): void {
  const binDir = join(home, '.fleet', 'bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'fleet');
  writeFileSync(bin, '#!/bin/sh\n', 'utf-8');
  chmodSync(bin, 0o755);
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => home };
});

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fleet-opencode-')); ensureFleetBin(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('opencode integration installer', () => {
  it('drops plugin file', async () => {
    await install();
    const path = join(home, '.config', 'opencode', 'plugins', 'fleet-agent-state.js');
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf-8');
    expect(body).toContain('fleet:opencode');
    expect(body).toContain('FLEET_INTEGRATION_VERSION=1');
  });

  it('uninstall removes plugin file', async () => {
    await install();
    await uninstall();
    expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'fleet-agent-state.js'))).toBe(false);
  });

  it('status reports installed=true after install', async () => {
    await install();
    const s = await status();
    expect(s.installed).toBe(true);
    expect(s.version).toBe(1);
  });

  it('status reports installed=false initially', async () => {
    const s = await status();
    expect(s.installed).toBe(false);
  });

  it('throws when fleet CLI is missing', async () => {
    rmSync(join(home, '.fleet'), { recursive: true });
    await expect(install()).rejects.toThrow(/fleet CLI/);
  });
});
