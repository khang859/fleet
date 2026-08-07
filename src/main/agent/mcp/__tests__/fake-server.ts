import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type Tool,
  type Transport
} from '@modelcontextprotocol/client';

/**
 * A server on the other end of a wire, for tests.
 *
 * Hand-written rather than mocked, and hand-written at the JSON-RPC layer
 * rather than by stubbing the client: what the manager has to get right is how
 * it behaves against a real `Client`, and a stubbed client would only prove the
 * manager agrees with the stub. The SDK's linked transport pair gives a real
 * client a real conversation to have.
 */
export type FakeServer = {
  transport: Transport;
  /** Announce a new tool list, the way a server fronting something live would. */
  changeTools: (tools: Tool[]) => Promise<void>;
  /** Every tool call that arrived, in order. */
  readonly calls: Array<{ name: string; args: unknown }>;
};

export type FakeServerOptions = {
  tools: Tool[];
  /** What `tools/call` returns. Defaults to echoing the tool name. */
  respond?: (name: string, args: unknown) => unknown;
  /** Fail every request, as a server that is up but broken would. */
  failEverything?: string;
};

export function fakeServer(options: FakeServerOptions): FakeServer {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let tools = options.tools;
  const calls: Array<{ name: string; args: unknown }> = [];

  const reply = async (id: unknown, result: unknown): Promise<void> => {
    await serverSide.send(asMessage({ jsonrpc: '2.0', id, result }));
  };

  serverSide.onmessage = (message: JSONRPCMessage) => {
    const request: Record<string, unknown> = { ...message };
    const { id, method } = request;
    if (id === undefined) return; // a notification; nothing to answer

    void (async () => {
      if (options.failEverything !== undefined) {
        await serverSide.send(
          asMessage({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: options.failEverything }
          })
        );
        return;
      }
      if (method === 'initialize') {
        await reply(id, {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake', version: '1.0.0' }
        });
        return;
      }
      if (method === 'tools/list') {
        await reply(id, { tools });
        return;
      }
      if (method === 'tools/call') {
        const params: Record<string, unknown> = { ...asRecord(request.params) };
        const name = String(params.name);
        calls.push({ name, args: params.arguments });
        const result = options.respond?.(name, params.arguments) ?? {
          content: [{ type: 'text', text: `ran ${name}` }]
        };
        await reply(id, result);
        return;
      }
      await serverSide.send(
        asMessage({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `no method ${String(method)}` }
        })
      );
    })();
  };

  void serverSide.start();

  return {
    transport: clientSide,
    calls,
    changeTools: async (next: Tool[]) => {
      tools = next;
      await serverSide.send(
        asMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      );
    }
  };
}

/** A transport that never finishes connecting, for the startup timeout. */
export function hangingTransport(): Transport {
  return {
    start: async () => new Promise<void>(() => {}),
    send: async () => {},
    close: async () => {}
  };
}

/**
 * Widen a literal to the wire message type.
 *
 * Validated by the SDK's own parser rather than asserted, which also means a
 * malformed reply written here fails in this file instead of surfacing as a
 * confusing client-side error three frames away.
 */
function asMessage(value: unknown): JSONRPCMessage {
  return parseJSONRPCMessage(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  return { ...value };
}
