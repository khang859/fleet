import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { install, isInstalled, uninstall, UnreadableSettingsError } from '../hook-installer';
import { isFleetHookCommand } from '../../../shared/claude-hooks';

const BINARY = `fleet-copilot-${process.platform === 'win32' ? 'windows' : process.platform}-${
  process.arch === 'arm64' ? 'arm64' : 'amd64'
}${process.platform === 'win32' ? '.exe' : ''}`;

let root: string;
let configDir: string;
let settingsPath: string;

type Settings = {
  hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  [k: string]: unknown;
};

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Settings;
}

function fleetCommands(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? [])
    .flatMap((entry) => entry.hooks.map((h) => h.command))
    .filter(isFleetHookCommand);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet hook installer '));
  // The installer copies the binary from `<cwd>/hooks/bin` in development.
  const binDir = join(root, 'repo', 'hooks', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, BINARY), '#!/bin/sh\necho fleet-hook-ran\n');
  chmodSync(join(binDir, BINARY), 0o755);
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'repo'));

  configDir = join(root, "O'Brien claude");
  mkdirSync(configDir);
  settingsPath = join(configDir, 'settings.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('install', () => {
  it.each([
    ['invalid JSON', '{\n  // notes\n  "model": "opus",\n}\n'],
    ['a non-object top level', '["model"]\n']
  ])('leaves settings with %s byte-for-byte unchanged and touches nothing', (_label, text) => {
    writeFileSync(settingsPath, text);

    expect(() => install(configDir)).toThrow(UnreadableSettingsError);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(text);
    expect(existsSync(join(configDir, 'hooks'))).toBe(false);
    expect(existsSync(`${settingsPath}.fleet-bak`)).toBe(false);
  });

  it('creates settings when there are none', () => {
    install(configDir);

    expect(fleetCommands(readSettings(), 'SessionStart')).toHaveLength(1);
    expect(isInstalled(configDir)).toBe(true);
  });

  it('keeps every setting and hook it did not create, and backs up the previous file', () => {
    const before = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] }
    };
    const beforeText = JSON.stringify(before, null, 2);
    writeFileSync(settingsPath, beforeText);

    install(configDir);

    const after = readSettings();
    expect(after.model).toBe('opus');
    expect(after.permissions).toEqual(before.permissions);
    expect(after.hooks?.Stop[0]?.hooks[0]?.command).toBe('notify-send done');
    expect(fleetCommands(after, 'Stop')).toHaveLength(1);
    expect(readFileSync(`${settingsPath}.fleet-bak`, 'utf-8')).toBe(beforeText);
    expect(readdirSync(configDir).filter((name) => name.includes('fleet-tmp'))).toEqual([]);
  });

  it('carries malformed hook values through untouched', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Custom: 'not-an-array' } }));

    install(configDir);

    expect(readSettings().hooks?.Custom).toBe('not-an-array');
  });

  it.skipIf(process.platform === 'win32')(
    'writes a command that runs from a folder with spaces and an apostrophe',
    () => {
      install(configDir);

      const [command] = fleetCommands(readSettings(), 'SessionStart');
      expect(execSync(command, { shell: '/bin/sh' }).toString().trim()).toBe('fleet-hook-ran');
    }
  );

  it('is idempotent', () => {
    install(configDir);
    const first = readFileSync(settingsPath, 'utf-8');

    install(configDir);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(first);
    expect(fleetCommands(readSettings(), 'PreCompact')).toHaveLength(2);
  });

  it('replaces older unquoted and legacy Python entries with the current ones', () => {
    const hookDest = join(configDir, 'hooks', BINARY);
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: hookDest }] }],
          Stop: [
            { hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/fleet-copilot.py' }] }
          ]
        }
      })
    );

    install(configDir);

    const after = readSettings();
    expect(fleetCommands(after, 'SessionStart')).toHaveLength(1);
    expect(fleetCommands(after, 'SessionStart')[0]).not.toBe(hookDest);
    expect(JSON.stringify(after)).not.toContain('fleet-copilot.py');
  });
});

describe('uninstall', () => {
  it('removes only Fleet entries', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] }
      })
    );
    install(configDir);

    uninstall(configDir);

    const after = readSettings();
    expect(after.hooks).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }]
    });
    expect(isInstalled(configDir)).toBe(false);
  });

  it('drops the hooks key when only Fleet used it', () => {
    install(configDir);

    uninstall(configDir);

    expect(readSettings().hooks).toBeUndefined();
  });

  it('leaves unreadable settings untouched', () => {
    const text = '{ broken';
    writeFileSync(settingsPath, text);

    uninstall(configDir);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(text);
  });
});
