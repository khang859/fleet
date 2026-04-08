import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from './logger';

const log = createLogger('fleet-bridge');

export type BridgeRequest = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

export type BridgeResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

export type BridgeEvent = {
  type: string;
  payload: Record<string, unknown>;
};

type RequestHandler = (
  type: string,
  payload: Record<string, unknown>,
  paneId: string
) => Promise<unknown>;

export class FleetBridgeServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private token = '';
  private connections = new Map<string, WebSocket>();
  private requestHandler: RequestHandler | null = null;

  getPort(): number {
    return this.port;
  }

  generateToken(): string {
    this.token = randomUUID();
    return this.token;
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  async start(): Promise<void> {
    this.token = randomUUID();

    return new Promise((resolve, reject) => {
      this.httpServer = createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '/', `http://localhost`);
        const providedToken = url.searchParams.get('token');
        const paneId = url.searchParams.get('paneId');

        if (providedToken !== this.token) {
          log.warn('Bridge connection rejected: invalid token');
          ws.close(4001, 'Invalid token');
          return;
        }

        if (!paneId) {
          log.warn('Bridge connection rejected: missing paneId');
          ws.close(4002, 'Missing paneId');
          return;
        }

        log.info('Bridge connection accepted', { paneId });
        this.connections.set(paneId, ws);

        ws.on('message', (raw) => {
          void this.handleMessage(raw.toString(), paneId);
        });

        ws.on('close', () => {
          log.info('Bridge connection closed', { paneId });
          this.connections.delete(paneId);
        });

        ws.on('error', (err) => {
          log.error('Bridge connection error', {
            paneId,
            error: err.message,
          });
        });
      });

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        log.info('Fleet bridge started', { port: this.port });
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  sendEvent(paneId: string, event: BridgeEvent): void {
    const ws = this.connections.get(paneId);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  broadcast(event: BridgeEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.connections.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  private async handleMessage(raw: string, paneId: string): Promise<void> {
    let msg: BridgeRequest;
    try {
      msg = JSON.parse(raw) as BridgeRequest;
    } catch {
      log.warn('Bridge received invalid JSON', { paneId });
      return;
    }

    if (!msg.id || !msg.type) {
      log.warn('Bridge received malformed message', { paneId, msg });
      return;
    }

    const ws = this.connections.get(paneId);
    if (!ws) return;

    try {
      const result = await (this.requestHandler?.(msg.type, msg.payload, paneId) ?? null);
      const response: BridgeResponse = { id: msg.id, result };
      ws.send(JSON.stringify(response));
    } catch (err) {
      const response: BridgeResponse = {
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
      ws.send(JSON.stringify(response));
    }
  }
}
