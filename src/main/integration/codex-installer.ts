import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { bashAgentStateScript } from './hook-scripts';
import { resolveFleetBin } from './shared';
import type { InstallStatus } from './index';

const SCRIPT_NAME = 'fleet-agent-state.sh';

type CodexHook = { event: string; command: string[] };
type CodexHooksFile = { hooks?: CodexHook[]; [k: string]: unknown };

function paths(home = homedir()): { codexDir: string; hooks: string; toml: string; script: string } {
  const codexDir = join(home, '.codex');
  return {
    codexDir,
    hooks: join(codexDir, 'hooks.json'),
    toml: join(codexDir, 'config.toml'),
    script: join(codexDir, SCRIPT_NAME)
  };
}

function eventCommands(script: string): CodexHook[] {
  return [
    { event: 'SessionStart', command: [script, 'working'] },
    { event: 'UserPromptSubmit', command: [script, 'working'] },
    { event: 'PreToolUse', command: [script, 'working'] },
    { event: 'Stop', command: [script, 'idle'] },
    { event: 'SessionEnd', command: [script, 'release'] }
  ];
}

function patchTomlHooksFlag(toml: string): string {
  if (/^\s*\[features\]/m.test(toml)) {
    if (/^\s*hooks\s*=\s*true/m.test(toml)) return toml;
    return toml.replace(/^\s*\[features\][^\[]*/m, (block) => `${block.replace(/\s*$/, '')}\nhooks = true\n`);
  }
  return `${toml.replace(/\s*$/, '')}\n\n[features]\nhooks = true\n`;
}

function stripTomlHooksFlag(toml: string): string {
  return toml.replace(/^\s*hooks\s*=\s*true\s*$/m, '').replace(/\n{3,}/g, '\n\n');
}

export async function install(home = homedir()): Promise<void> {
  const p = paths(home);
  const bin = resolveFleetBin();
  if (!bin) throw new Error('fleet CLI not installed (~/.fleet/bin/fleet missing)');

  if (!existsSync(p.codexDir)) mkdirSync(p.codexDir, { recursive: true });
  writeFileSync(p.script, bashAgentStateScript('codex', bin), 'utf-8');
  chmodSync(p.script, 0o755);

  let file: CodexHooksFile = {};
  if (existsSync(p.hooks)) {
    try { file = JSON.parse(readFileSync(p.hooks, 'utf-8')); } catch { file = {}; }
  }
  const existing = file.hooks ?? [];
  const filtered = existing.filter((h) => !h.command.some((arg) => arg.includes(SCRIPT_NAME)));
  file.hooks = [...filtered, ...eventCommands(p.script)];
  writeFileSync(p.hooks, JSON.stringify(file, null, 2), 'utf-8');

  let toml = existsSync(p.toml) ? readFileSync(p.toml, 'utf-8') : '';
  toml = patchTomlHooksFlag(toml);
  writeFileSync(p.toml, toml, 'utf-8');
}

export async function uninstall(home = homedir()): Promise<void> {
  const p = paths(home);
  if (existsSync(p.script)) {
    try { unlinkSync(p.script); } catch { /* ignore */ }
  }
  if (existsSync(p.hooks)) {
    try {
      const file: CodexHooksFile = JSON.parse(readFileSync(p.hooks, 'utf-8'));
      file.hooks = (file.hooks ?? []).filter((h) => !h.command.some((a) => a.includes(SCRIPT_NAME)));
      writeFileSync(p.hooks, JSON.stringify(file, null, 2), 'utf-8');
    } catch { /* ignore */ }
  }
  if (existsSync(p.toml)) {
    const toml = readFileSync(p.toml, 'utf-8');
    writeFileSync(p.toml, stripTomlHooksFlag(toml), 'utf-8');
  }
}

export async function status(home = homedir()): Promise<InstallStatus> {
  const p = paths(home);
  if (!existsSync(p.script)) return { installed: false, version: null };
  const body = readFileSync(p.script, 'utf-8');
  const m = body.match(/FLEET_INTEGRATION_VERSION=(\d+)/);
  return { installed: true, version: m ? Number(m[1]) : null, path: p.script };
}
