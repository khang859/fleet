import type { Server } from 'net';
import { chmodSync, existsSync, unlinkSync } from 'fs';
import type { createLogger } from '../logger';

type Log = ReturnType<typeof createLogger>;

/**
 * Listen on a unix socket only its owner can use: whoever can connect speaks
 * for Claude Code sessions, and every one of them runs as this same user. A
 * socket file a crashed Fleet left behind is replaced.
 */
export async function listenOnSocket(server: Server, socketPath: string, log: Log): Promise<void> {
  removeSocketFile(socketPath, log);
  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      log.error('socket server error', { error: String(err) });
      reject(err);
    });
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        log.warn('failed to chmod socket');
      }
      log.info('listening', { path: socketPath });
      resolve();
    });
  });
}

export function removeSocketFile(socketPath: string, log: Log): void {
  if (!existsSync(socketPath)) return;
  try {
    unlinkSync(socketPath);
  } catch {
    log.warn('failed to remove socket file', { path: socketPath });
  }
}
