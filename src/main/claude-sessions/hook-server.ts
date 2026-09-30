import { createServer, type Server, type Socket } from 'net';
import { unlinkSync, existsSync, chmodSync } from 'fs';
import { createLogger } from '../logger';
import { COPILOT_SOCKET_PATH } from '../../shared/constants';
import { parseHookEvent, type HookEvent } from './hook-events';

const log = createLogger('claude-sessions:hook-server');

/**
 * Handles one hook event. Returns true when it kept the connection to answer
 * later (a permission request); otherwise the server closes it.
 */
export type HookEventHandler = (event: HookEvent, client: Socket) => boolean;

/** How long the Go hook waits for a permission answer, plus a little slack. */
const PERMISSION_HOLD_MS = 310_000;

/**
 * The unix socket the Go hook binary writes to. Each connection carries one
 * JSON event; the hook half-closes its side, and for a permission request it
 * waits for the answer on the same connection.
 */
export class HookServer {
  private server: Server | null = null;

  constructor(
    private readonly onEvent: HookEventHandler,
    private readonly socketPath: string = COPILOT_SOCKET_PATH
  ) {}

  async start(): Promise<void> {
    this.removeSocketFile();

    return new Promise((resolve, reject) => {
      const server = createServer({ allowHalfOpen: true }, (client) =>
        this.handleConnection(client)
      );
      this.server = server;

      server.on('error', (err) => {
        log.error('hook server error', { error: String(err) });
        reject(err);
      });

      server.listen(this.socketPath, () => {
        try {
          // Owner only: whoever can connect can forge session events and answer
          // permission requests, and every hook runs as this same user.
          chmodSync(this.socketPath, 0o600);
        } catch {
          log.warn('failed to chmod socket');
        }
        log.info('hook server listening', { path: this.socketPath });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    const STOP_TIMEOUT_MS = 5000;
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          log.warn('hook server stop timed out, forcing cleanup');
          resolve();
        }, STOP_TIMEOUT_MS).unref()
      )
    ]);
    this.removeSocketFile();
    log.info('hook server stopped');
  }

  private removeSocketFile(): void {
    if (!existsSync(this.socketPath)) return;
    try {
      unlinkSync(this.socketPath);
    } catch {
      log.warn('failed to remove socket file', { path: this.socketPath });
    }
  }

  private handleConnection(client: Socket): void {
    let buffer = '';

    client.on('data', (chunk) => {
      buffer += chunk.toString();
    });

    client.on('end', () => {
      if (!buffer.trim()) {
        client.end();
        return;
      }
      const event = parseHookEvent(buffer);
      if (!event) {
        log.warn('invalid hook event', { data: buffer.substring(0, 200) });
        client.end();
        return;
      }
      log.debug('hook event received', {
        sessionId: event.sessionId,
        event: event.event,
        status: event.status
      });

      let held = false;
      try {
        held = this.onEvent(event, client);
      } catch (err) {
        log.error('hook event handler failed', { error: String(err) });
      }
      // A connection nobody will answer is closed at once, so a hook waiting
      // for a permission answer falls back to Claude's own prompt.
      if (!held) client.end();
    });

    client.on('error', (err) => {
      log.debug('client socket error', { error: String(err) });
    });
  }
}

type HeldPermission = { sessionId: string; socket: Socket };

/**
 * Keeps the connections of hook processes waiting on a permission answer, and
 * delivers the answer when one comes.
 *
 * `onReleased` fires once per held request that goes away: answered here, or
 * dropped because the hook exited (the user answered in the terminal, or the
 * hook timed out).
 */
export class PermissionBroker {
  private readonly held = new Map<string, HeldPermission>();

  constructor(
    private readonly onReleased: (sessionId: string, toolUseId: string) => void,
    private readonly holdMs: number = PERMISSION_HOLD_MS
  ) {}

  hold(sessionId: string, toolUseId: string, socket: Socket): void {
    this.held.set(toolUseId, { sessionId, socket });
    // The hook has already half-closed its side, so its exit is not seen until
    // something is written. The timeout destroys the socket so 'close' fires.
    socket.setTimeout(this.holdMs);
    socket.on('timeout', () => socket.destroy());
    socket.on('close', () => {
      const current = this.held.get(toolUseId);
      if (current?.socket !== socket) return;
      log.info('permission hook went away', { toolUseId, sessionId });
      this.release(toolUseId);
    });
    log.debug('holding permission', { toolUseId });
  }

  has(toolUseId: string): boolean {
    return this.held.has(toolUseId);
  }

  respond(toolUseId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const pending = this.held.get(toolUseId);
    if (!pending) {
      log.warn('no held permission', { toolUseId });
      return false;
    }
    let delivered = true;
    try {
      pending.socket.end(JSON.stringify({ decision, reason: reason ?? '' }));
    } catch (err) {
      log.error('failed to write permission answer', { toolUseId, error: String(err) });
      delivered = false;
    }
    this.release(toolUseId);
    if (delivered) log.info('permission answered', { toolUseId, decision });
    return delivered;
  }

  /**
   * Drop held requests the session no longer lists, without reporting them:
   * the event stream already said they are settled (the tool ran, or the turn
   * ended), typically because the user answered in the terminal.
   */
  retainOnly(sessionId: string, toolUseIds: ReadonlySet<string>): void {
    for (const [toolUseId, pending] of this.held) {
      if (pending.sessionId !== sessionId || toolUseIds.has(toolUseId)) continue;
      this.held.delete(toolUseId);
      pending.socket.destroy();
    }
  }

  /** Close every held connection, giving the hooks a moment to read the end. */
  async dispose(): Promise<void> {
    const sockets = [...this.held.values()].map((h) => h.socket);
    this.held.clear();
    for (const socket of sockets) socket.end();
    if (sockets.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const socket of sockets) socket.destroy();
  }

  private release(toolUseId: string): void {
    const pending = this.held.get(toolUseId);
    if (!pending) return;
    this.held.delete(toolUseId);
    this.onReleased(pending.sessionId, toolUseId);
  }
}
