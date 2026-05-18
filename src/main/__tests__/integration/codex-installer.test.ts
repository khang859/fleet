import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { install, uninstall, status } from '../../integration/codex-installer';

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

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fleet-codex-')); ensureFleetBin(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('codex integration installer', () => {
  it('creates script, hooks.json, and patches config.toml', async () => {
    await install();
    expect(existsSync(join(home, '.codex', 'fleet-agent-state.sh'))).toBe(true);
    const hooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.find((h: { event: string }) => h.event === 'SessionStart')).toBeDefined();
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/\[features\][\s\S]*hooks = true/);
  });

  it('preserves existing config.toml content', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[model]\nname = "gpt-5"\n', 'utf-8');
    await install();
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/\[model\]/);
    expect(toml).toMatch(/hooks = true/);
  });

  it('is idempotent', async () => {
    await install();
    await install();
    const hooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8'));
    const sessionStarts = hooks.hooks.filter((h: { event: string }) => h.event === 'SessionStart');
    expect(sessionStarts.length).toBe(1);
  });

  it('uninstall removes script + entries + toml flag', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[model]\nname = "gpt-5"\n', 'utf-8');
    await install();
    await uninstall();
    expect(existsSync(join(home, '.codex', 'fleet-agent-state.sh'))).toBe(false);
    const hooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.length).toBe(0);
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8');
    expect(toml).not.toMatch(/hooks = true/);
    expect(toml).toMatch(/\[model\]/);
  });

  it('status reports installed=true after install', async () => {
    await install();
    expect((await status()).installed).toBe(true);
  });
});
