import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { COPILOT_SOCKET_PATH, FLEET_HOME } from '../../shared/constants';
import { getHookBinarySourcePath } from '../claude-sessions/hook-installer';
import { withFleetPaneEnv } from '../fleet-pane-env';

describe('withFleetPaneEnv', () => {
  it('names the hook socket and keeps the rest of the env', () => {
    expect(withFleetPaneEnv({ PATH: '/bin' }, false)).toEqual({
      PATH: '/bin',
      FLEET_COPILOT_SOCKET: COPILOT_SOCKET_PATH
    });
  });

  it("drops a dev Fleet's hand-off names in a release build", () => {
    const env = withFleetPaneEnv({ FLEET_HOOK_BIN: '/dev/hook', FLEET_CLI: '/dev/fleet' }, false);
    expect(env).not.toHaveProperty('FLEET_HOOK_BIN');
    expect(env).not.toHaveProperty('FLEET_CLI');
  });

  it("hands a dev pane's hook and CLI to this checkout's own builds", () => {
    const env = withFleetPaneEnv({ FLEET_HOOK_BIN: '/other/hook' }, true);
    expect(env.FLEET_HOOK_BIN).toBe(getHookBinarySourcePath());
    expect(env.FLEET_CLI).toBe(join(FLEET_HOME, 'bin', 'fleet'));
  });
});
