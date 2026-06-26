import { describe, it, expect, vi } from 'vitest';
import { McpClient } from '../client';
import type { Transport } from '../transport';

/**
 * A fake transport that records sent messages and lets the test drive replies.
 * It auto-replies to `initialize` so connect() resolves; other requests are
 * answered explicitly via `reply()`.
 */
class FakeTransport implements Transport {
  sent: Array<{ id?: number; method: string; params?: unknown }> = [];
  private handler: (m: unknown) => void = () => {};
  started = false;
  closed = false;
  autoInitialize = true;

  async start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  async send(message: unknown): Promise<void> {
    const m = message as { id?: number; method: string; params?: unknown };
    this.sent.push(m);
    if (this.autoInitialize && m.method === 'initialize') {
      queueMicrotask(() => this.reply(m.id!, { protocolVersion: '2025-06-18' }));
    }
    return Promise.resolve();
  }

  setHandler(cb: (m: unknown) => void): void {
    this.handler = cb;
  }

  async close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  reply(id: number, result: unknown): void {
    this.handler({ jsonrpc: '2.0', id, result });
  }

  replyError(id: number, message: string): void {
    this.handler({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }
}

describe('McpClient', () => {
  it('performs the initialize handshake and sends initialized notification', async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await client.connect();
    expect(t.started).toBe(true);
    expect(t.sent.find((m) => m.method === 'initialize')).toBeTruthy();
    expect(t.sent.find((m) => m.method === 'notifications/initialized')).toBeTruthy();
  });

  it('lists tools and defaults a missing inputSchema', async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await client.connect();

    const listP = client.listTools();
    const req = t.sent.find((m) => m.method === 'tools/list')!;
    t.reply(req.id!, {
      tools: [
        { name: 'search', description: 'find', inputSchema: { type: 'object' } },
        { name: 'noschema' }
      ]
    });
    const tools = await listP;
    expect(tools).toEqual([
      { name: 'search', description: 'find', inputSchema: { type: 'object' } },
      { name: 'noschema', description: undefined, inputSchema: { type: 'object', properties: {} } }
    ]);
  });

  it('correlates responses to requests by id', async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await client.connect();

    const callP = client.callTool('search', { q: 'hi' });
    const req = t.sent.find((m) => m.method === 'tools/call')!;
    expect(req.params).toEqual({ name: 'search', arguments: { q: 'hi' } });
    t.reply(req.id!, { content: [{ type: 'text', text: 'ok' }] });
    await expect(callP).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('rejects when the server returns an error', async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await client.connect();

    const callP = client.callTool('boom', {});
    const req = t.sent.find((m) => m.method === 'tools/call')!;
    t.replyError(req.id!, 'tool exploded');
    await expect(callP).rejects.toThrow('tool exploded');
  });

  it('rejects pending requests on close', async () => {
    const t = new FakeTransport();
    const client = new McpClient(t);
    await client.connect();

    const callP = client.callTool('slow', {});
    await client.close();
    await expect(callP).rejects.toThrow('MCP client closed');
    expect(t.closed).toBe(true);
  });

  it('times out a request that never gets a reply', async () => {
    vi.useFakeTimers();
    try {
      const t = new FakeTransport();
      const client = new McpClient(t);
      await client.connect();
      const callP = client.callTool('hang', {});
      const expectation = expect(callP).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(30_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
