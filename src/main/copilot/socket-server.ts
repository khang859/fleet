import { createServer, type Server, type Socket } from 'net';
import { unlinkSync, existsSync, chmodSync } from 'fs';
import { createLogger } from '../logger';
import { COPILOT_SOCKET_PATH } from '../../shared/constants';
import type { CopilotSessionStore, HookEvent } from './session-store';

const log = createLogger('copilot:socket');

type PendingSocket = {
  sessionId: string;
  toolUseId: string;
  socket: Socket;
};

export class CopilotSocketServer {
  private server: Server | null = null;
  private pendingSockets = new Map<string, PendingSocket>();
  private sessionStore: CopilotSessionStore;

  constructor(sessionStore: CopilotSessionStore) {
    this.sessionStore = sessionStore;
  }

  async start(): Promise<void> {
    if (existsSync(COPILOT_SOCKET_PATH)) {
      try {
        unlinkSync(COPILOT_SOCKET_PATH);
      } catch {
        log.warn('failed to remove stale socket', { path: COPILOT_SOCKET_PATH });
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer({ allowHalfOpen: true }, (client) =>
        this.handleConnection(client)
      );

      this.server.on('error', (err) => {
        log.error('socket server error', { error: String(err) });
        reject(err);
      });

      this.server.listen(COPILOT_SOCKET_PATH, () => {
        try {
          chmodSync(COPILOT_SOCKET_PATH, 0o777);
        } catch {
          log.warn('failed to chmod socket');
        }
        log.info('socket server listening', { path: COPILOT_SOCKET_PATH });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Send graceful end to pending sockets before destroying
    for (const [, pending] of this.pendingSockets) {
      try {
        pending.socket.end();
      } catch {
        // socket may already be closed
      }
    }
    // Give clients 500ms to receive the FIN, then force-destroy
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const [, pending] of this.pendingSockets) {
      try {
        pending.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.pendingSockets.clear();

    if (!this.server) return;

    const STOP_TIMEOUT_MS = 5000;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.cleanupSocket();
          log.info('socket server stopped');
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log.warn('socket server stop timed out, forcing cleanup');
          this.cleanupSocket();
          resolve();
        }, STOP_TIMEOUT_MS);
      }),
    ]);
    this.server = null;
  }

  private cleanupSocket(): void {
    if (existsSync(COPILOT_SOCKET_PATH)) {
      try {
        unlinkSync(COPILOT_SOCKET_PATH);
      } catch {
        // ignore
      }
    }
  }

  respondToPermission(
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): boolean {
    const pending = this.pendingSockets.get(toolUseId);
    if (!pending) {
      log.warn('no pending socket for toolUseId', { toolUseId });
      return false;
    }

    const response = JSON.stringify({ decision, reason: reason ?? '' });
    try {
      pending.socket.write(response);
      pending.socket.end();
    } catch (err) {
      log.error('failed to write permission response', { toolUseId, error: String(err) });
      return false;
    } finally {
      this.pendingSockets.delete(toolUseId);
    }

    this.sessionStore.removePermission(pending.sessionId, toolUseId);
    log.info('permission responded', { toolUseId, decision });
    return true;
  }

  private handleConnection(client: Socket): void {
    let buffer = '';

    client.on('data', (chunk) => {
      buffer += chunk.toString();
    });

    client.on('end', () => {
      if (!buffer.trim()) return;

      let event: HookEvent;
      try {
        event = JSON.parse(buffer);
      } catch {
        log.warn('invalid JSON from hook', { data: buffer.substring(0, 200) });
        return;
      }

      log.debug('hook event received', {
        sessionId: event.session_id,
        event: event.event,
        status: event.status,
      });

      this.sessionStore.processHookEvent(event);

      if (event.status === 'waiting_for_approval') {
        const session = this.sessionStore.getSession(event.session_id);
        const lastPermission = session?.pendingPermissions.at(-1);
        if (lastPermission) {
          this.pendingSockets.set(lastPermission.toolUseId, {
            sessionId: event.session_id,
            toolUseId: lastPermission.toolUseId,
            socket: client,
          });
          log.debug('holding socket for permission', {
            toolUseId: lastPermission.toolUseId,
          });
          return;
        }
      }
    });

    client.on('close', () => {
      // When the hook process exits (e.g. user approved permission in terminal,
      // or hook timed out), clean up any pending permission tied to this socket.
      for (const [id, pending] of this.pendingSockets) {
        if (pending.socket === client) {
          log.info('socket closed, clearing stale permission', {
            toolUseId: id,
            sessionId: pending.sessionId,
          });
          this.pendingSockets.delete(id);
          this.sessionStore.removePermission(pending.sessionId, id);
          break;
        }
      }
    });

    client.on('error', (err) => {
      log.debug('client socket error', { error: String(err) });
    });
  }
}
