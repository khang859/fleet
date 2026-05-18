import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { opencodePlugin } from './hook-scripts';
import { resolveFleetBin } from './shared';
import type { InstallStatus } from './index';

const PLUGIN_NAME = 'fleet-agent-state.js';

function paths(home = homedir()): { pluginsDir: string; plugin: string } {
  const pluginsDir = join(home, '.config', 'opencode', 'plugins');
  return { pluginsDir, plugin: join(pluginsDir, PLUGIN_NAME) };
}

export async function install(home = homedir()): Promise<void> {
  const p = paths(home);
  const bin = resolveFleetBin();
  if (!bin) throw new Error('fleet CLI not installed (~/.fleet/bin/fleet missing)');
  if (!existsSync(p.pluginsDir)) mkdirSync(p.pluginsDir, { recursive: true });
  writeFileSync(p.plugin, opencodePlugin(bin), 'utf-8');
}

export async function uninstall(home = homedir()): Promise<void> {
  const p = paths(home);
  if (existsSync(p.plugin)) {
    try { unlinkSync(p.plugin); } catch { /* ignore */ }
  }
}

export async function status(home = homedir()): Promise<InstallStatus> {
  const p = paths(home);
  if (!existsSync(p.plugin)) return { installed: false, version: null };
  const body = readFileSync(p.plugin, 'utf-8');
  const m = body.match(/FLEET_INTEGRATION_VERSION=(\d+)/);
  return { installed: true, version: m ? Number(m[1]) : null, path: p.plugin };
}
