import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { McpDetectedServer, McpServersConfig, McpSnapshot } from '../../../shared/agent-mcp';
import { McpServersConfigSchema } from '../../../shared/agent-mcp';
import type { McpManager } from './manager';
import type { AgentMcpSecrets } from './secrets';
import { detectServers, importServers } from './import/detect';
import { createLogger } from '../../logger';

const log = createLogger('agent-mcp-ipc');

/**
 * The MCP settings pane's side of the wall.
 *
 * Two rules shape all of it. Nothing that can be typed is trusted: a config
 * from the renderer becomes a process to spawn or a URL to POST to, so it is
 * checked here rather than believed. And no credential ever comes back: a token
 * goes in and is answered with whether one is now set, never with what it is.
 *
 * Every call that changes something answers with the fresh statuses, so the
 * pane never has to ask a second time to find out what its own click did.
 */

/**
 * The parts of the manager this layer touches.
 *
 * Narrow on purpose: everything here is a button in the settings pane, and a
 * layer that could reach further would eventually be asked to.
 */
export type McpControl = Pick<McpManager, 'statuses' | 'reload' | 'reconnect' | 'signIn'>;

export type McpIpcDeps = {
  manager: McpControl;
  secrets: AgentMcpSecrets;
  getServers: () => McpServersConfig;
  setServers: (next: McpServersConfig) => void;
};

/**
 * How long a sign-in may sit waiting on a browser tab.
 *
 * Long enough for someone to find the right account and get through two-factor,
 * short enough that a tab closed and forgotten does not leave a port listening
 * for the rest of the session.
 */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const Picked = z.array(z.object({ name: z.string(), path: z.string() }));

export function registerAgentMcpIpc(deps: McpIpcDeps): void {
  // One per server: clicking Sign in again while a browser tab is still open
  // means "that one did not work", so the first attempt is dropped rather than
  // left holding a port.
  const running = new Map<string, AbortController>();

  const snapshot = (): McpSnapshot => {
    const servers = deps.getServers();
    return {
      servers,
      statuses: deps.manager.statuses(),
      credentials: Object.fromEntries(
        Object.keys(servers).map((name) => [
          name,
          deps.secrets.isSignedIn(name) || deps.secrets.hasToken(name)
        ])
      )
    };
  };

  ipcMain.handle(IPC_CHANNELS.AGENT_MCP_GET, (): McpSnapshot => snapshot());

  ipcMain.handle(IPC_CHANNELS.AGENT_MCP_SET, async (_e, next: unknown): Promise<McpSnapshot> => {
    const parsed = McpServersConfigSchema.safeParse(next);
    if (!parsed.success) throw new Error('That is not a set of MCP servers.');

    forgetRemoved(deps, parsed.data);
    deps.setServers(parsed.data);
    await deps.manager.reload();
    return snapshot();
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_MCP_RECONNECT,
    async (_e, name: string): Promise<McpSnapshot> => {
      await deps.manager.reconnect(name);
      return snapshot();
    }
  );

  // Rejects rather than answering with an error string: this one is a button
  // the user pressed and waited on, and what went wrong belongs next to it.
  ipcMain.handle(IPC_CHANNELS.AGENT_MCP_SIGN_IN, async (_e, name: string): Promise<McpSnapshot> => {
    running.get(name)?.abort();
    const controller = new AbortController();
    running.set(name, controller);

    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SIGN_IN_TIMEOUT_MS)]);
    try {
      await deps.manager.signIn(name, signal);
      await rememberOAuth(deps, name);
      return snapshot();
    } finally {
      if (running.get(name) === controller) running.delete(name);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_MCP_SIGN_OUT,
    async (_e, name: string): Promise<McpSnapshot> => {
      running.get(name)?.abort();
      deps.secrets.invalidate(name, 'all');
      deps.secrets.clearToken(name);
      await deps.manager.reconnect(name);
      return snapshot();
    }
  );

  // `null` clears it. The value goes straight into the encrypted store and is
  // never read back out to the renderer, so a field the user cannot re-read is
  // the intended behaviour rather than an oversight.
  ipcMain.handle(
    IPC_CHANNELS.AGENT_MCP_SET_TOKEN,
    async (_e, name: string, token: string | null): Promise<McpSnapshot> => {
      if (token === null || token === '') deps.secrets.clearToken(name);
      else deps.secrets.setToken(name, token);
      await deps.manager.reconnect(name);
      return snapshot();
    }
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_MCP_DETECT, (_e, cwd: string): McpDetectedServer[] => {
    try {
      return detectServers({ existing: deps.getServers(), paths: { cwd } });
    } catch (err) {
      // A scan is a convenience. Someone whose home directory is unreadable
      // should get an empty dialog, not a settings pane that will not open.
      log.warn('detection failed', { error: String(err) });
      return [];
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_MCP_IMPORT,
    async (_e, picked: unknown, cwd: string): Promise<McpSnapshot> => {
      const parsed = Picked.safeParse(picked);
      if (!parsed.success) throw new Error('That is not a list of servers to import.');

      const existing = deps.getServers();
      // Read again in main rather than trusting what came back: what the dialog
      // was shown had its credentials taken out, and this is the step that is
      // allowed to see them.
      const added = importServers(parsed.data, {
        existing,
        paths: { cwd },
        secrets: deps.secrets
      });

      deps.setServers({ ...existing, ...added });
      await deps.manager.reload();
      return snapshot();
    }
  );
}

/**
 * Write down that this server signs in with OAuth, once it has.
 *
 * A server imported from another tool arrives with no `auth` at all - the
 * credential lived in that tool's own store, not in the config. Fleet finds out
 * it needs one by being refused, and the user fixes it by signing in. Without
 * this the discovery is thrown away the moment the app restarts: nothing would
 * attach a provider on the next connect, so the stored tokens would never be
 * sent and the server would ask all over again.
 *
 * Reconnects afterwards so the sign-in takes effect on the connection the user
 * was waiting for, rather than on the next restart.
 */
async function rememberOAuth(deps: McpIpcDeps, name: string): Promise<void> {
  const servers = deps.getServers();
  const config = servers[name];
  if (config === undefined || config.auth?.kind === 'oauth') return;

  deps.setServers({ ...servers, [name]: { ...config, auth: { kind: 'oauth' } } });
  await deps.manager.reload();
}

/**
 * Throw away the credentials of a server that is no longer configured.
 *
 * Otherwise removing a server leaves its token in the keychain for as long as
 * the app is installed, and adding one back under the same name would silently
 * sign in as whoever was there before.
 */
function forgetRemoved(deps: McpIpcDeps, next: McpServersConfig): void {
  for (const name of Object.keys(deps.getServers())) {
    if (next[name] === undefined) deps.secrets.forget(name);
  }
}
