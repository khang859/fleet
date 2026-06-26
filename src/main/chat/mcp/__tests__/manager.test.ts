import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpManager, budgetResult } from '../manager';
import type { McpServersConfig } from '../../../../shared/mcp-types';

/**
 * A mock `fetch` that speaks just enough Streamable-HTTP MCP to drive a full
 * connect → tools/list → tools/call cycle. It dispatches on the JSON-RPC method
 * in the request body. The manager builds an HttpTransport whose fetchImpl
 * defaults to the global `fetch`, so stubbing the global wires it in.
 */
function mockMcpFetch(handlers: {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  call?: (name: string, args: unknown) => unknown;
}): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to match fetch's signature
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const msg = JSON.parse(init?.body ?? '{}') as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: unknown };
    };
    const json = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    if (msg.method === 'initialize') return json({ protocolVersion: '2025-06-18' });
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') return json({ tools: handlers.tools });
    if (msg.method === 'tools/call') {
      const out = handlers.call?.(msg.params?.name ?? '', msg.params?.arguments);
      return json(out ?? { content: [{ type: 'text', text: 'default' }] });
    }
    return json({});
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('McpManager', () => {
  it('connects an HTTP server, namespaces tools, and routes a call', async () => {
    vi.stubGlobal(
      'fetch',
      mockMcpFetch({
        tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }],
        call: (name, args) => ({
          content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }]
        })
      })
    );
    const config: McpServersConfig = { srv: { url: 'http://localhost/mcp', enabled: true } };
    const mgr = new McpManager(() => config);
    await mgr.reload();

    const status = mgr.statuses()[0];
    expect(status).toMatchObject({
      name: 'srv',
      transport: 'http',
      state: 'connected',
      toolCount: 1
    });

    const defs = mgr.getToolDefs() as Array<{ function: { name: string } }>;
    expect(defs[0].function.name).toBe('mcp__srv__echo');
    expect(mgr.hasTool('mcp__srv__echo')).toBe(true);
    expect(mgr.hasTool('mcp__srv__nope')).toBe(false);

    const out = await mgr.callTool('mcp__srv__echo', '{"x":1}');
    expect(out).toBe('echo:{"x":1}');
    await mgr.closeAll();
  });

  it('keeps disabled servers in config but exposes no tools', async () => {
    const config: McpServersConfig = { off: { command: 'whatever', enabled: false } };
    const mgr = new McpManager(() => config);
    await mgr.reload();

    expect(mgr.getToolDefs()).toEqual([]);
    expect(mgr.statuses()[0]).toMatchObject({ name: 'off', state: 'disabled', toolCount: 0 });
  });

  it('returns a message for unknown tools without throwing', async () => {
    const mgr = new McpManager(() => ({}));
    await mgr.reload();
    expect(await mgr.callTool('mcp__ghost__x', '{}')).toContain('Unknown MCP tool');
  });

  it('rejects invalid JSON arguments', async () => {
    vi.stubGlobal('fetch', mockMcpFetch({ tools: [{ name: 'echo' }] }));
    const mgr = new McpManager(() => ({ srv: { url: 'http://localhost/mcp', enabled: true } }));
    await mgr.reload();
    expect(await mgr.callTool('mcp__srv__echo', '{not json')).toContain('Invalid tool arguments');
    await mgr.closeAll();
  });
});

describe('budgetResult', () => {
  it('flattens MCP content blocks to joined text', () => {
    expect(
      budgetResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      })
    ).toBe('a\nb');
  });

  it('falls back to JSON for non-content results', () => {
    expect(budgetResult({ foo: 1 })).toBe('{"foo":1}');
  });

  it('reports empty results as (no output)', () => {
    expect(budgetResult({ content: [] })).toBe('(no output)');
  });

  it('truncates very large results', () => {
    const big = { content: [{ type: 'text', text: 'x'.repeat(26_000) }] };
    const out = budgetResult(big);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(26_000);
  });

  it('annotates large-but-not-truncated results', () => {
    const out = budgetResult({ content: [{ type: 'text', text: 'y'.repeat(12_000) }] });
    expect(out).toContain('large result');
  });
});
