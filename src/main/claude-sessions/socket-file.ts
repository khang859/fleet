import type { Server } from 'net';
import { chmodSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import type { createLogger } from '../logger';

type Log = ReturnType<typeof createLogger>;

/**
 * Listen on a unix socket only its owner can use: whoever can connect speaks
 * for Claude Code sessions, and every one of them runs as this same user. A
 * socket file a crashed Fleet left behind is replaced.
 *
 * The socket's folder is made owner-only first, so no one else can reach the
 * socket in the moment between `listen()` making it and the chmod below.
 */
export async function listenOnSocket(server: Server, socketPath: string, log: Log): Promise<void> {
  if (process.platform !== 'win32') tryChmod(dirname(socketPath), 0o700, log);
  removeSocketFile(socketPath, log);
  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      log.error('socket server error', { error: String(err) });
      reject(err);
    });
    server.listen(socketPath, () => {
      tryChmod(socketPath, 0o600, log);
      log.info('listening', { path: socketPath });
      resolve();
    });
  });
}

function tryChmod(path: string, mode: number, log: Log): void {
  try {
    chmodSync(path, mode);
  } catch {
    log.warn('failed to chmod', { path });
  }
}

export function removeSocketFile(socketPath: string, log: Log): void {
  if (!existsSync(socketPath)) return;
  try {
    unlinkSync(socketPath);
  } catch {
    log.warn('failed to remove socket file', { path: socketPath });
  }
}
