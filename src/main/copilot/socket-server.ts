import { createServer, type Server, type Socket } from 'net';
import { unlinkSync, existsSync, chmodSync } from 'fs';
import { createLogger } from '../logger';
import type { CopilotSessionStore, HookEvent } from './session-store';

const log = createLogger('copilot:socket');

const SOCKET_PATH = '/tmp/fleet-copilot.sock';

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
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        log.warn('failed to remove stale socket', { path: SOCKET_PATH });
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((client) => this.handleConnection(client));

      this.server.on('error', (err) => {
        log.error('socket server error', { error: String(err) });
        reject(err);
      });

      this.server.listen(SOCKET_PATH, () => {
        try {
          chmodSync(SOCKET_PATH, 0o777);
        } catch {
          log.warn('failed to chmod socket');
        }
        log.info('socket server listening', { path: SOCKET_PATH });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const [, pending] of this.pendingSockets) {
      pending.socket.destroy();
    }
    this.pendingSockets.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        if (existsSync(SOCKET_PATH)) {
          try {
            unlinkSync(SOCKET_PATH);
          } catch {
            // ignore
          }
        }
        log.info('socket server stopped');
        resolve();
      });
    });
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

    client.on('error', (err) => {
      log.debug('client socket error', { error: String(err) });
    });
  }
}
