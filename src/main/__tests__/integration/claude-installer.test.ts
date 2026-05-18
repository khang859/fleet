import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { install, uninstall, status } from '../../integration/claude-installer';

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-claude-'));
  ensureFleetBin();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('claude integration installer', () => {
  it('install creates script and patches settings.json', async () => {
    await install();
    expect(existsSync(join(home, '.claude', 'hooks', 'fleet-agent-state.sh'))).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain('fleet-agent-state.sh needs_me');
  });

  it('install is idempotent', async () => {
    await install();
    await install();
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
  });

  it('install preserves existing unrelated hooks', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/some/other/hook' }] }] } }),
      'utf-8'
    );
    await install();
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.UserPromptSubmit.length).toBe(2);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/some/other/hook');
  });

  it('uninstall removes script and entries but leaves unrelated hooks', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/some/other/hook' }] }] } }),
      'utf-8'
    );
    await install();
    await uninstall();
    expect(existsSync(join(home, '.claude', 'hooks', 'fleet-agent-state.sh'))).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/some/other/hook');
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
