import { spawn, type ChildProcess } from 'child_process';

/** A bidirectional JSON-RPC message channel to an MCP server. */
export interface Transport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  setHandler(cb: (message: unknown) => void): void;
  close(): Promise<void>;
}

/** stdio transport: newline-delimited JSON over a spawned child's stdin/stdout. */
export class StdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private buffer = '';
  private handler: (m: unknown) => void = () => {};

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env?: Record<string, string>
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env }
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    return Promise.resolve();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.handler(JSON.parse(line));
      } catch {
        // ignore non-JSON log noise on stdout
      }
    }
  }

  async send(message: unknown): Promise<void> {
    this.child?.stdin?.write(JSON.stringify(message) + '\n');
    return Promise.resolve();
  }

  setHandler(cb: (m: unknown) => void): void {
    this.handler = cb;
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.child = null;
    return Promise.resolve();
  }
}

/**
 * Streamable HTTP transport: each client message is POSTed; the server replies
 * with either a single JSON object or an SSE stream (`text/event-stream`). We
 * only do request/response (initialize, tools/list, tools/call), so this
 * suffices without a long-lived GET channel. Captures Mcp-Session-Id.
 */
export class HttpTransport implements Transport {
  private handler: (m: unknown) => void = () => {};
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async start(): Promise<void> {
    return Promise.resolve();
  }

  setHandler(cb: (m: unknown) => void): void {
    this.handler = cb;
  }

  async send(message: unknown): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message)
    });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    // Notifications get a 202 with no body.
    if (res.status === 202) return;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text().catch(() => '')}`);

    const ctype = res.headers.get('Content-Type') ?? '';
    const body = await res.text();
    if (ctype.includes('text/event-stream')) {
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          this.handler(JSON.parse(data));
        } catch {
          /* ignore */
        }
      }
    } else if (body.trim()) {
      this.handler(JSON.parse(body));
    }
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
