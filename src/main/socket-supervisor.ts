import { EventEmitter } from 'node:events';
import { SocketServer } from './socket-server';
import type { ImageService } from './image-service';
import type { AnnotateService } from './annotate-service';
import { createLogger } from './logger';

const log = createLogger('socket-supervisor');

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
    private imageService?: ImageService,
    private annotateService?: AnnotateService,
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
        log.error('Max restarts exceeded in 5-minute window, giving up');
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
          log.error('Error stopping server during restart', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
        this.server = null;
      }

      this.server = this.createServer();
      await this.server.start();

      this.restartTimestamps.push(Date.now());
      log.info('Server restarted successfully');
      this.emit('restarted');
    } catch (err) {
      log.error('Restart failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      this.restartTimestamps.push(Date.now());
    } finally {
      this.isRestarting = false;
    }
  }

  private createServer(): SocketServer {
    const server = new SocketServer(this.socketPath, this.imageService, this.annotateService);

    server.on('state-change', (...args: unknown[]) => {
      this.emit('state-change', ...args);
    });

    server.on('file-open', (...args: unknown[]) => {
      this.emit('file-open', ...args);
    });

    server.on('server-error', (err: Error) => {
      log.error('Server error detected', { error: err.message });
      this.restart().catch((e) =>
        log.error('Auto-restart failed', {
          error: e instanceof Error ? e.message : String(e)
        })
      );
    });

    server.on('server-close', () => {
      if (!this.isStopped) {
        log.warn('Server closed unexpectedly');
        this.restart().catch((e) =>
          log.error('Auto-restart failed', {
            error: e instanceof Error ? e.message : String(e)
          })
        );
      }
    });

    return server;
  }

  resetBackoff(): void {
    this.backoffMs = INITIAL_BACKOFF_MS;
  }
}
