import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AnnotateService } from './annotate-service';
import { CodedError } from './errors';

type Request = {
  id?: string;
  command: string;
  args?: Record<string, unknown>;
};

function isRequest(v: unknown): v is Request {
  return (
    v != null &&
    typeof v === 'object' &&
    'command' in v &&
    typeof (v as { command?: unknown }).command === 'string'
  );
}

type SuccessResponse = {
  id?: string;
  ok: true;
  data: unknown;
};

type ErrorResponse = {
  id?: string;
  ok: false;
  error: string;
  code?: string;
};

type Response = SuccessResponse | ErrorResponse;

/**
 * SocketServer — Unix socket server for Fleet CLI command dispatch.
 *
 * Listens on a given socket path, accepts newline-delimited JSON requests,
 * routes commands to service methods, and returns JSON responses.
 * Emits 'state-change' events for mutating commands.
 */
export class SocketServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private startTime: number | null = null;

  constructor(
    private socketPath: string,
    private annotateService?: AnnotateService
  ) {
    super();
  }

  async start(): Promise<void> {
    // Ensure parent directory exists
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Clean up stale socket file
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore — file may not exist
    }

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
            void this.handleLine(socket, line);
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
        });
      });

      this.server.on('close', () => {
        this.emit('server-close');
      });

      // Use once for startup error — detaches after first fire so it doesn't linger
      this.server.once('error', reject);

      this.server.listen(this.socketPath, () => {
        // Remove startup error handler and attach permanent one for post-startup errors
        this.server?.off('error', reject);
        this.server?.on('error', (err) => {
          this.emit('server-error', err);
        });
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // Ignore — file may already be gone
          }
          resolve();
        });
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let req: Request;

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRequest(parsed)) {
        this.sendResponse(socket, { ok: false, error: 'Invalid request' });
        return;
      }
      req = parsed;
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    try {
      const data = await this.dispatch(req.command, req.args ?? {});
      this.sendResponse(socket, { id: req.id, ok: true, data });
    } catch (err) {
      const coded =
        err instanceof CodedError
          ? err
          : err instanceof Error
            ? new CodedError(err.message, 'UNKNOWN')
            : new CodedError(String(err), 'UNKNOWN');
      this.sendResponse(socket, { id: req.id, ok: false, error: coded.message, code: coded.code });
    }
  }

  private sendResponse(socket: Socket, response: Response): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }

  private async dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'ping':
        return { pong: true, uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0 };

      // ── File Open ──────────────────────────────────────────────────────────────
      case 'file.open': {
        if (!Array.isArray(args.files) || args.files.length === 0) {
          throw new CodedError('file.open requires a non-empty files array', 'BAD_REQUEST');
        }
        const files = args.files.filter(
          (f): f is Record<string, unknown> => f != null && typeof f === 'object'
        );
        const payload = {
          files: files.map((f) => {
            const filePath = typeof f.path === 'string' ? f.path : '';
            const paneType: 'file' | 'image' | 'markdown' | 'pdf' =
              f.paneType === 'image'
                ? 'image'
                : f.paneType === 'markdown'
                  ? 'markdown'
                  : f.paneType === 'pdf'
                    ? 'pdf'
                    : 'file';
            return {
              path: filePath,
              paneType,
              label: filePath.split('/').pop() ?? filePath
            };
          })
        };
        this.emit('file-open', payload);
        return { fileCount: files.length };
      }

      // ── Annotate ──────────────────────────────────────────────────────────────
      case 'annotate.start': {
        if (!this.annotateService)
          throw new CodedError('Annotate service not available', 'UNAVAILABLE');
        const url = typeof args.url === 'string' ? args.url : undefined;
        const timeout =
          typeof args.timeout === 'number'
            ? args.timeout
            : typeof args.timeout === 'string'
              ? Number(args.timeout)
              : undefined;
        const resultPath = await this.annotateService.start({ url, timeout });
        return { resultPath };
      }

      default: {
        throw new CodedError(`Unknown command: ${command}`, 'NOT_FOUND');
      }
    }
  }
}
