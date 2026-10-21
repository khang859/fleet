import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { homedir, tmpdir } from 'os';
import { BRIDGE_SOCKET_PATH, CLAUDE_MOD_DIR } from '../../../shared/constants';
import { claudeModEnv, copyClaudeMod } from '../claude-mod';

const SOURCE = join(__dirname, '..', '..', '..', '..', 'resources', 'claude-mod', 'fleet-bridge');

describe('copyClaudeMod', () => {
  let dest: string;

  const write = (file: string, text = 'x'): void => {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    writeFileSync(join(dest, file), text);
  };

  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'fleet-claude-mod-'));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  it("writes the mod's files", () => {
    copyClaudeMod(SOURCE, dest);
    for (const file of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts']) {
      expect(readFileSync(join(dest, file), 'utf8')).toBe(readFileSync(join(SOURCE, file), 'utf8'));
    }
  });

  it('removes files an older Fleet shipped and this one does not', () => {
    write('hooks/old.ts');
    write('hooks/nested/old.json');
    write('.claude-plugin/old.json');
    copyClaudeMod(SOURCE, dest);
    expect(existsSync(join(dest, 'hooks/old.ts'))).toBe(false);
    expect(existsSync(join(dest, 'hooks/nested/old.json'))).toBe(false);
    expect(existsSync(join(dest, '.claude-plugin/old.json'))).toBe(false);
    expect(existsSync(join(dest, 'hooks/register.ts'))).toBe(true);
  });

  it('leaves the type files Claude Code writes', () => {
    write('.claude-plugin/types/index.d.ts');
    write('hooks/types/hooks.d.ts');
    write('tsconfig.json');
    copyClaudeMod(SOURCE, dest);
    expect(existsSync(join(dest, '.claude-plugin/types/index.d.ts'))).toBe(true);
    expect(existsSync(join(dest, 'hooks/types/hooks.d.ts'))).toBe(true);
    expect(existsSync(join(dest, 'tsconfig.json'))).toBe(true);
  });
});

describe('claudeModEnv', () => {
  it('loads the mod and names the bridge socket', () => {
    expect(claudeModEnv({}, 'darwin')).toEqual({
      CLAUDE_CODE_PLUGIN_DIRS: CLAUDE_MOD_DIR,
      FLEET_BRIDGE_SOCKET: BRIDGE_SOCKET_PATH
    });
  });

  it("keeps the user's own plugin folders", () => {
    const env = { CLAUDE_CODE_PLUGIN_DIRS: ['/a', '/b'].join(delimiter) };
    expect(claudeModEnv(env, 'linux').CLAUDE_CODE_PLUGIN_DIRS).toBe(
      ['/a', '/b', CLAUDE_MOD_DIR].join(delimiter)
    );
  });

  it('drops the mod folder of the Fleet it was started from, dev or not, so one mod asks', () => {
    const fleet = (...parts: string[]): string =>
      join(homedir(), '.fleet', ...parts, 'fleet-bridge');
    const env = {
      CLAUDE_CODE_PLUGIN_DIRS: [
        fleet('claude-mods'),
        '/a',
        fleet('claude-mods-dev'),
        fleet('dev', '0123456789ab', 'claude-mods')
      ].join(delimiter)
    };
    expect(claudeModEnv(env, 'darwin').CLAUDE_CODE_PLUGIN_DIRS).toBe(
      ['/a', CLAUDE_MOD_DIR].join(delimiter)
    );
  });

  it('sets nothing on Windows, where the mod has no socket to reach', () => {
    expect(claudeModEnv({ CLAUDE_CODE_PLUGIN_DIRS: '/a' }, 'win32')).toEqual({});
  });
});
