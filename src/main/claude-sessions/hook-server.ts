import { createServer, type Server, type Socket } from 'net';
import { createLogger } from '../logger';
import { COPILOT_SOCKET_PATH } from '../../shared/constants';
import { HOOK_PROTOCOL, parseHookEvent, type HookEvent } from './hook-events';
import type { HeldRequest, PermissionAnswer } from './permission-broker';
import { listenOnSocket, removeSocketFile } from './socket-file';

const log = createLogger('claude-sessions:hook-server');

/**
 * Handles one hook event. Returns true when it kept the connection to answer
 * later (a permission request); otherwise the server closes it.
 */
export type HookEventHandler = (event: HookEvent, client: Socket) => boolean;

/**
 * How long a permission request is held. Shorter than the Go hook's own wait
 * (`timeoutSeconds` in hooks/fleet-copilot-go/main.go): once the hook gives up,
 * its exit is not seen, so an answer sent after it would be reported as
 * delivered while Claude Code still shows its prompt. Letting go first clears
 * the request in Fleet and hands it to that prompt.
 */
export const PERMISSION_HOLD_MS = 295_000;

/**
 * The unix socket the Go hook binary writes to. Each connection carries one
 * JSON event; the hook half-closes its side, and for a permission request it
 * waits for the answer on the same connection.
 */
export class HookServer {
  private server: Server | null = null;
  /** Protocols newer than this Fleet that were already logged, so each is logged once. */
  private readonly unknownProtocols = new Set<number>();

  constructor(
    private readonly onEvent: HookEventHandler,
    private readonly socketPath: string = COPILOT_SOCKET_PATH
  ) {}

  async start(): Promise<void> {
    this.server = createServer({ allowHalfOpen: true }, (client) => this.handleConnection(client));
    return listenOnSocket(this.server, this.socketPath, log);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    const STOP_TIMEOUT_MS = 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn('hook server stop timed out, forcing cleanup');
          resolve();
        }, STOP_TIMEOUT_MS).unref();
      })
    ]);
    clearTimeout(timer);
    removeSocketFile(this.socketPath, log);
    log.info('hook server stopped');
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
      if (event.protocol > HOOK_PROTOCOL) {
        // A newer hook binary's fields may mean something this Fleet misreads.
        if (!this.unknownProtocols.has(event.protocol)) {
          this.unknownProtocols.add(event.protocol);
          log.warn('ignoring hook events of an unknown protocol', { protocol: event.protocol });
        }
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

/**
 * A Go hook's permission request, held on its connection. The hook has already
 * half-closed its side, so its exit is not seen until something is written:
 * the timeout destroys the socket so 'close' fires.
 */
export class SocketHold implements HeldRequest {
  constructor(
    private readonly socket: Socket,
    holdMs: number = PERMISSION_HOLD_MS
  ) {
    socket.setTimeout(holdMs);
    socket.on('timeout', () => socket.destroy());
  }

  deliver(answer: PermissionAnswer): boolean {
    const { decision, reason, updatedPermissions } = answer;
    this.socket.end(
      JSON.stringify({
        decision,
        reason,
        ...(updatedPermissions && { updated_permissions: updatedPermissions })
      })
    );
    return true;
  }

  letGo(): void {
    this.socket.end();
  }

  discard(): void {
    this.socket.destroy();
  }

  onGone(cb: () => void): void {
    this.socket.on('close', cb);
  }
}
