import { join } from 'node:path';
import { COPILOT_SOCKET_PATH, FLEET_HOME, IS_FLEET_DEV } from '../shared/constants';
import { getHookBinarySourcePath } from './claude-sessions/hook-installer';

type Env = Record<string, string | undefined>;

/**
 * Tell the Claude Code hook and the `fleet` CLI in a pane which Fleet they
 * belong to. Both are the installed app's copies, which a dev build never
 * replaces, so a dev pane also names its checkout's own builds for them to
 * hand off to. A release build drops those names, in case it was started from
 * a dev pane. Dropped, not set to undefined: node-pty passes that on as text.
 */
export function withFleetPaneEnv(env: Env, dev: boolean = IS_FLEET_DEV): Env {
  const out: Env = { ...env, FLEET_COPILOT_SOCKET: COPILOT_SOCKET_PATH };
  delete out.FLEET_HOOK_BIN;
  delete out.FLEET_CLI;
  if (!dev) return out;

  return {
    ...out,
    FLEET_HOOK_BIN: getHookBinarySourcePath(),
    FLEET_CLI: join(FLEET_HOME, 'bin', 'fleet')
  };
}
