import * as net from 'net';
import type { SystemDepResult } from '../shared/ipc-api';
import { SOCKET_PATH } from '../shared/constants';

const SOCK_HINT =
  'Fleet socket is not running. The app may still be starting up — try clicking Retry in a moment.';

function attemptFleetSock(): Promise<SystemDepResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_PATH);
    let responded = false;

    const fail = (): void => {
      if (responded) return;
      responded = true;
      socket.destroy();
      resolve({ name: 'fleet.sock', found: false, installHint: SOCK_HINT });
    };

    socket.setTimeout(3000);
    socket.on('timeout', fail);
    socket.on('error', fail);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ command: 'ping' }) + '\n');
    });

    let buf = '';
    socket.on('data', (data) => {
      if (responded) return;
      buf += data.toString();
      const line = buf.split('\n')[0];
      try {
        const rawMsg: unknown = JSON.parse(line);
        const msg =
          rawMsg != null && typeof rawMsg === 'object'
            ? (rawMsg as { ok?: boolean; data?: { pong?: boolean; uptime?: number } })
            : {};
        if (msg.ok === true && msg.data?.pong === true) {
          responded = true;
          socket.destroy();
          const uptime = msg.data.uptime;
          const version = uptime !== undefined ? `uptime: ${Math.round(uptime)}s` : undefined;
          resolve({ name: 'fleet.sock', found: true, version, installHint: SOCK_HINT });
        }
      } catch {
        // keep buffering
      }
    });

    socket.on('close', () => {
      if (!responded) fail();
    });
  });
}

async function checkFleetSock(maxAttempts = 3, delayMs = 1500): Promise<SystemDepResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await attemptFleetSock();
    if (result.found) return result;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { name: 'fleet.sock', found: false, installHint: SOCK_HINT };
}

export async function checkSystemDeps(): Promise<SystemDepResult[]> {
  return [await checkFleetSock()];
}
