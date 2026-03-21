import { EventEmitter } from 'node:events';
import { SocketServer, type ServiceRegistry, type AsyncServiceRegistry } from './socket-server';

const MAX_RESTARTS = 5;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class SocketSupervisor extends EventEmitter {
  private server: SocketServer | null = null;
  private isRestarting = false;
  private isStopped = false;
  private restartTimestamps: number[] = [];
  private backoffMs = INITIAL_BACKOFF_MS;

  constructor(
    private socketPath: string,
    private services: ServiceRegistry | AsyncServiceRegistry
  ) {
    super();
  }

  async start(): Promise<void> {
    this.isStopped = false;
    this.server = this.createServer();
    await this.server.start();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }

  async restart(): Promise<void> {
    if (this.isRestarting || this.isStopped) return;
    this.isRestarting = true;

    try {
      const now = Date.now();
      this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < WINDOW_MS);

      if (this.restartTimestamps.length >= MAX_RESTARTS) {
        console.error('[socket-supervisor] Max restarts exceeded in 5-minute window, giving up');
        this.emit('failed');
        return;
      }

      if (this.restartTimestamps.length > 0) {
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }

      if (this.server) {
        try {
          await this.server.stop();
        } catch (err) {
          console.error('[socket-supervisor] Error stopping server during restart:', err);
        }
        this.server = null;
      }

      if (this.isStopped) return;

      this.server = this.createServer();
      await this.server.start();

      this.restartTimestamps.push(Date.now());
      console.log('[socket-supervisor] Server restarted successfully');
      this.emit('restarted');
    } catch (err) {
      console.error('[socket-supervisor] Restart failed:', err);
      this.restartTimestamps.push(Date.now());
    } finally {
      this.isRestarting = false;
    }
  }

  private createServer(): SocketServer {
    const server = new SocketServer(this.socketPath, this.services);

    server.on('state-change', (...args: unknown[]) => {
      this.emit('state-change', ...args);
    });

    server.on('file-open', (...args: unknown[]) => {
      this.emit('file-open', ...args);
    });

    server.on('server-error', (err: Error) => {
      console.error('[socket-supervisor] Server error detected:', err.message);
      this.restart().catch((e) => console.error('[socket-supervisor] Auto-restart failed:', e));
    });

    server.on('server-close', () => {
      if (!this.isStopped) {
        console.warn('[socket-supervisor] Server closed unexpectedly');
        this.restart().catch((e) => console.error('[socket-supervisor] Auto-restart failed:', e));
      }
    });

    return server;
  }

  resetBackoff(): void {
    this.backoffMs = INITIAL_BACKOFF_MS;
  }
}
