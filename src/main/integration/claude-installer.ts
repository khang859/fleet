import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { bashAgentStateScript } from './hook-scripts';
import { resolveFleetBin } from './shared';
import type { InstallStatus } from './index';

const SCRIPT_NAME = 'fleet-agent-state.sh';

type HookEntry = { matcher?: string; hooks: { type: string; command: string }[] };
type ClaudeSettings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

function paths(home = homedir()): { claudeDir: string; hooksDir: string; settings: string; script: string } {
  const claudeDir = join(home, '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  return {
    claudeDir,
    hooksDir,
    settings: join(claudeDir, 'settings.json'),
    script: join(hooksDir, SCRIPT_NAME)
  };
}

function eventMap(scriptPath: string): Record<string, HookEntry[]> {
  const cmd = (arg: string): HookEntry => ({
    hooks: [{ type: 'command', command: `${scriptPath} ${arg}` }]
  });
  const matcherCmd = (matcher: string, arg: string): HookEntry => ({
    matcher,
    hooks: [{ type: 'command', command: `${scriptPath} ${arg}` }]
  });
  return {
    UserPromptSubmit: [cmd('working')],
    PreToolUse: [matcherCmd('*', 'working')],
    PostToolUse: [matcherCmd('*', 'working')],
    PermissionRequest: [matcherCmd('*', 'needs_me')],
    Notification: [matcherCmd('*', 'needs_me')],
    Stop: [cmd('idle')],
    SubagentStop: [cmd('working')],
    SessionEnd: [cmd('release')]
  };
}

function hasFleetAgentHook(entries: HookEntry[]): boolean {
  return entries.some((e) => e.hooks.some((h) => h.command.includes(SCRIPT_NAME)));
}

export async function install(home = homedir()): Promise<void> {
  const p = paths(home);
  const bin = resolveFleetBin();
  if (!bin) throw new Error('fleet CLI not installed (~/.fleet/bin/fleet missing)');

  if (!existsSync(p.hooksDir)) mkdirSync(p.hooksDir, { recursive: true });
  writeFileSync(p.script, bashAgentStateScript('claude', bin), 'utf-8');
  chmodSync(p.script, 0o755);

  let settings: ClaudeSettings = {};
  if (existsSync(p.settings)) {
    try { settings = JSON.parse(readFileSync(p.settings, 'utf-8')); } catch { settings = {}; }
  }
  const hooks = settings.hooks ?? {};
  for (const [event, entries] of Object.entries(eventMap(p.script))) {
    const existing = hooks[event] ?? [];
    if (!hasFleetAgentHook(existing)) hooks[event] = [...existing, ...entries];
  }
  settings.hooks = hooks;
  writeFileSync(p.settings, JSON.stringify(settings, null, 2), 'utf-8');
}

export async function uninstall(home = homedir()): Promise<void> {
  const p = paths(home);
  if (existsSync(p.script)) {
    try { unlinkSync(p.script); } catch { /* ignore */ }
  }
  if (!existsSync(p.settings)) return;
  let settings: ClaudeSettings;
  try { settings = JSON.parse(readFileSync(p.settings, 'utf-8')); } catch { return; }
  const hooks = settings.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? []).filter(
      (e) => !e.hooks.some((h) => h.command.includes(SCRIPT_NAME))
    );
    if (hooks[event].length === 0) delete hooks[event];
  }
  settings.hooks = hooks;
  writeFileSync(p.settings, JSON.stringify(settings, null, 2), 'utf-8');
}

export async function status(home = homedir()): Promise<InstallStatus> {
  const p = paths(home);
  if (!existsSync(p.script)) return { installed: false, version: null };
  const body = readFileSync(p.script, 'utf-8');
  const m = body.match(/FLEET_INTEGRATION_VERSION=(\d+)/);
  return { installed: true, version: m ? Number(m[1]) : null, path: p.script };
}
