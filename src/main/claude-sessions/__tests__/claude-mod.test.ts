import { describe, expect, it } from 'vitest';
import { delimiter, join } from 'path';
import { homedir } from 'os';
import { BRIDGE_SOCKET_PATH, CLAUDE_MOD_DIR } from '../../../shared/constants';
import { claudeModEnv } from '../claude-mod';

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
