import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The wall between the settings pane and the servers.
 *
 * Worth testing at this seam rather than through the UI, because the two rules
 * that matter here are invisible from either side: a config arriving from the
 * renderer is not trusted, and no credential ever goes back the other way.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
    decryptString: (enc: Buffer) => enc.toString().slice(4)
  }
}));

const { registerAgentMcpIpc } = await import('../mcp-ipc');
const { AgentMcpSecrets } = await import('../secrets');
const { IPC_CHANNELS } = await import('../../../../shared/ipc-channels');
const { MCP_SECRET_REF, McpServersConfigSchema } = await import('../../../../shared/agent-mcp');
import { z } from 'zod';
import type { McpServersConfig, McpServerStatus, McpSnapshot } from '../../../../shared/agent-mcp';

/**
 * The wire shape, checked rather than asserted.
 *
 * Everything here crosses a process boundary, so a handler that answered with
 * the wrong shape should fail at the boundary rather than in whichever
 * expectation happens to read the missing field.
 */
const StatusShape: z.ZodType<McpServerStatus> = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  state: z.enum(['connected', 'connecting', 'needs-auth', 'failed', 'disabled']),
  toolCount: z.number(),
  error: z.string().optional(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      wireName: z.string(),
      enabled: z.boolean(),
      readOnly: z.boolean()
    })
  )
});

const SnapshotShape: z.ZodType<McpSnapshot> = z.object({
  servers: McpServersConfigSchema,
  statuses: z.array(StatusShape),
  credentials: z.record(z.string(), z.boolean())
});

function store(): { get: () => Record<string, never>; set: (next: unknown) => void } {
  let data: unknown = {};
  return {
    get: () => JSON.parse(JSON.stringify(data)),
    set: (next) => {
      data = next;
    }
  };
}

/** Just enough manager to answer the calls the IPC layer makes on it. */
function fakeManager(): {
  statuses: () => McpServerStatus[];
  reload: () => Promise<void>;
  reconnect: (name: string) => Promise<void>;
  signIn: (name: string, signal?: AbortSignal) => Promise<void>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    statuses: () => [],
    reload: async () => {
      calls.push('reload');
      return Promise.resolve();
    },
    reconnect: async (name) => {
      calls.push(`reconnect:${name}`);
      return Promise.resolve();
    },
    signIn: async (name) => {
      calls.push(`signIn:${name}`);
      return Promise.resolve();
    }
  };
}

let servers: McpServersConfig;
let secrets: InstanceType<typeof AgentMcpSecrets>;
let manager: ReturnType<typeof fakeManager>;
/** Flipped by the one test that needs a scan to go wrong on purpose. */
let readingFails: boolean;

beforeEach(() => {
  handlers.clear();
  servers = {};
  readingFails = false;
  secrets = new AgentMcpSecrets({ store: store() });
  manager = fakeManager();

  registerAgentMcpIpc({
    // The IPC layer only ever calls these four, which is what makes a stand-in
    // honest here rather than a shortcut.
    manager,
    secrets,
    getServers: () => {
      if (readingFails) throw new Error('cannot be read');
      return servers;
    },
    setServers: (next) => {
      servers = next;
    }
  });
});

async function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`nothing is listening on ${channel}`);
  // Awaited here because a handler may answer with a value or a promise, and
  // every caller wants it settled either way.
  const answer: unknown = await handler({}, ...args);
  return answer;
}

async function snapshot(channel: string, ...args: unknown[]): Promise<McpSnapshot> {
  return SnapshotShape.parse(await call(channel, ...args));
}

const HTTP: McpServersConfig = { docs: { url: 'https://docs.example.com/mcp', enabled: true } };

describe('reading the settings pane', () => {
  it('answers with the servers, their state, and nothing else', async () => {
    servers = HTTP;

    const snap = await snapshot(IPC_CHANNELS.AGENT_MCP_GET);

    expect(snap.servers).toEqual(HTTP);
    expect(snap.statuses).toEqual([]);
    expect(snap.credentials).toEqual({ docs: false });
  });

  it('says a server has a credential without saying what it is', async () => {
    servers = HTTP;
    secrets.setToken('docs', 'sekrit');

    const snap = await snapshot(IPC_CHANNELS.AGENT_MCP_GET);

    expect(snap.credentials.docs).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('sekrit');
  });
});

describe('saving', () => {
  it('persists, reconnects, and answers with what happened', async () => {
    const snap = await snapshot(IPC_CHANNELS.AGENT_MCP_SET, HTTP);

    expect(servers).toEqual(HTTP);
    expect(manager.calls).toContain('reload');
    expect(snap.servers).toEqual(HTTP);
  });

  it('refuses something that is not a set of servers', async () => {
    servers = HTTP;

    // A config becomes a process to spawn or a URL to POST to. What arrives
    // from the renderer is checked rather than believed.
    await expect(call(IPC_CHANNELS.AGENT_MCP_SET, { docs: { command: 42 } })).rejects.toThrow();
    await expect(call(IPC_CHANNELS.AGENT_MCP_SET, 'nope')).rejects.toThrow();
    expect(servers).toEqual(HTTP);
  });

  it('drops fields that do not belong rather than passing them on', async () => {
    await call(IPC_CHANNELS.AGENT_MCP_SET, {
      docs: { url: 'https://docs.example.com/mcp', enabled: true, somethingElse: 'x' }
    });

    expect(servers.docs).not.toHaveProperty('somethingElse');
  });

  it('forgets the credentials of a server that was removed', async () => {
    servers = HTTP;
    secrets.setToken('docs', 'sekrit');

    await call(IPC_CHANNELS.AGENT_MCP_SET, {});

    // Otherwise a server added back under the same name would silently sign in
    // as whoever was there before.
    expect(secrets.getToken('docs')).toBeNull();
  });

  it('keeps the credentials of a server that is still there', async () => {
    servers = HTTP;
    secrets.setToken('docs', 'sekrit');

    await call(IPC_CHANNELS.AGENT_MCP_SET, {
      docs: { url: 'https://docs.example.com/mcp', enabled: false }
    });

    expect(secrets.getToken('docs')).toBe('sekrit');
  });
});

describe('credentials', () => {
  it('takes a token in and never hands it back', async () => {
    servers = HTTP;

    const snap = await snapshot(IPC_CHANNELS.AGENT_MCP_SET_TOKEN, 'docs', 'sekrit');

    expect(secrets.getToken('docs')).toBe('sekrit');
    expect(snap.credentials.docs).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('sekrit');
    expect(manager.calls).toContain('reconnect:docs');
  });

  it('clears the token when the field is emptied', async () => {
    servers = HTTP;
    secrets.setToken('docs', 'sekrit');

    await call(IPC_CHANNELS.AGENT_MCP_SET_TOKEN, 'docs', null);

    expect(secrets.getToken('docs')).toBeNull();
  });

  it('signs out of everything, not just the part that expired', async () => {
    servers = HTTP;
    secrets.setToken('docs', 'sekrit');
    secrets.saveTokens('docs', 'https://auth.example', {
      access_token: 'at',
      token_type: 'Bearer'
    });

    const snap = await snapshot(IPC_CHANNELS.AGENT_MCP_SIGN_OUT, 'docs');

    expect(secrets.isSignedIn('docs')).toBe(false);
    expect(secrets.getToken('docs')).toBeNull();
    expect(snap.credentials.docs).toBe(false);
  });

  it('signs in and answers with the state that came of it', async () => {
    servers = HTTP;

    await snapshot(IPC_CHANNELS.AGENT_MCP_SIGN_IN, 'docs');

    expect(manager.calls).toContain('signIn:docs');
  });

  it('writes down that this server signs in, once it has', async () => {
    // A server imported from another tool arrives with no `auth` at all - the
    // credential was in that tool's own store. Fleet learns it needs one by
    // being refused, and that has to survive a restart or the stored tokens
    // would never be sent again.
    servers = HTTP;

    await call(IPC_CHANNELS.AGENT_MCP_SIGN_IN, 'docs');

    expect(servers.docs?.auth).toEqual({ kind: 'oauth' });
    expect(manager.calls).toContain('reload');
  });

  it('leaves a server that already said how it signs in alone', async () => {
    servers = { docs: { ...HTTP.docs, url: 'https://docs.example.com/mcp', enabled: true } };

    await call(IPC_CHANNELS.AGENT_MCP_SIGN_IN, 'docs');
    const first = servers;
    await call(IPC_CHANNELS.AGENT_MCP_SIGN_IN, 'docs');

    // Rewritten once, not on every sign-in: each write is a settings save and a
    // reconnect of every server in the list.
    expect(servers).toBe(first);
  });

  it('has nothing to write down for a server that has since been removed', async () => {
    servers = HTTP;
    const gone = call(IPC_CHANNELS.AGENT_MCP_SIGN_IN, 'nowhere');

    await expect(gone).resolves.toBeDefined();
    expect(servers).toEqual(HTTP);
  });
});

describe('importing', () => {
  it('refuses a list that is not a list of servers', async () => {
    await expect(call(IPC_CHANNELS.AGENT_MCP_IMPORT, [{ name: 1 }], '/work')).rejects.toThrow();
  });

  it('answers with nothing rather than failing when a scan cannot be run', async () => {
    readingFails = true;

    // A scan is a convenience. Someone whose config cannot be read should get
    // an empty dialog, not a settings pane that will not open.
    const found = await call(IPC_CHANNELS.AGENT_MCP_DETECT, '/nowhere-at-all');

    expect(found).toEqual([]);
  });
});

describe('what a saved config may carry', () => {
  it('accepts a lifted-secret marker, because that is what an import writes', async () => {
    await call(IPC_CHANNELS.AGENT_MCP_SET, {
      docs: {
        url: 'https://docs.example.com/mcp',
        headers: { 'x-api-key': MCP_SECRET_REF },
        enabled: true
      }
    });

    expect(servers.docs?.headers).toEqual({ 'x-api-key': MCP_SECRET_REF });
  });
});
