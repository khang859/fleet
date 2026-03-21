import { createServer, Server, Socket } from 'net';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface SocketCommandHandler {
  handleCommand(cmd: SocketCommand): Promise<SocketResponse>;
}

export type SocketCommand = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

export type SocketResponse = {
  ok: boolean;
  id?: string;
  error?: string;
  [key: string]: unknown;
};

export class SocketApi {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private subscriptions = new Map<Socket, Set<string>>();

  constructor(
    private socketPath: string,
    private handler: SocketCommandHandler,
  ) {}

  async start(): Promise<void> {
    // Ensure parent directory exists
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Remove stale socket file
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(this.socketPath);
    } catch {}

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            this.handleLine(socket, line);
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
          this.subscriptions.delete(socket);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
          this.subscriptions.delete(socket);
        });
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions to owner-only (Unix)
        if (process.platform !== 'win32') {
          const { chmodSync } = require('fs');
          chmodSync(this.socketPath, 0o600);
        }
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.subscriptions.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ event: eventType, ...data }) + '\n';
    for (const [socket, events] of this.subscriptions) {
      if (events.has(eventType)) {
        socket.write(message);
      }
    }
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let cmd: SocketCommand;
    try {
      cmd = JSON.parse(line);
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    // Handle subscribe specially — accumulates event types across calls
    if (cmd.type === 'subscribe') {
      const events = Array.isArray(cmd.events) ? cmd.events.filter((e): e is string => typeof e === 'string') : [];
      const existing = this.subscriptions.get(socket) ?? new Set();
      for (const e of events) existing.add(e);
      this.subscriptions.set(socket, existing);
      this.sendResponse(socket, { ok: true, id: cmd.id });
      return;
    }

    try {
      const response = await this.handler.handleCommand(cmd);
      this.sendResponse(socket, { ...response, id: cmd.id });
    } catch (err) {
      this.sendResponse(socket, {
        ok: false,
        id: cmd.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  private sendResponse(socket: Socket, response: SocketResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }
}
