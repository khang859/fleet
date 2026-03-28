import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import type { SocketSupervisor as SocketSupervisorType } from '../socket-supervisor';

let SocketSupervisor: typeof SocketSupervisorType;

function tmpSocket(): string {
  return join(tmpdir(), `fleet-sv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

async function sendPing(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ id: 'ping-1', command: 'ping', args: {} }) + '\n');
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1 && lines[0].trim()) {
        client.end();
        try {
          resolve(JSON.parse(lines[0]));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => {
      client.destroy();
      reject(new Error('timeout'));
    }, 3000);
  });
}

describe('SocketSupervisor', () => {
  let socketPath: string;
  let supervisor: InstanceType<typeof SocketSupervisor>;

  beforeEach(async () => {
    ({ SocketSupervisor } = await import('../socket-supervisor'));
    socketPath = tmpSocket();
  });

  afterEach(async () => {
    await supervisor?.stop();
    try {
      unlinkSync(socketPath);
    } catch {
      // intentional
    }
  });

  it('starts and accepts ping', async () => {
    supervisor = new SocketSupervisor(socketPath);
    await supervisor.start();

    const response = await sendPing(socketPath);
    expect(response.ok).toBe(true);
    expect((response.data as any).pong).toBe(true);
  });

  it('exposes restart() method that restarts the server', async () => {
    supervisor = new SocketSupervisor(socketPath);
    await supervisor.start();

    const restartedPromise = new Promise<void>((resolve) => {
      supervisor.on('restarted', resolve);
    });

    await supervisor.restart();
    await restartedPromise;

    const response = await sendPing(socketPath);
    expect(response.ok).toBe(true);
  });

  it('concurrent restart calls are deduplicated', async () => {
    supervisor = new SocketSupervisor(socketPath);
    await supervisor.start();

    let restartCount = 0;
    supervisor.on('restarted', () => restartCount++);

    await Promise.all([supervisor.restart(), supervisor.restart()]);
    await new Promise((r) => setTimeout(r, 100));

    expect(restartCount).toBe(1);
  });

  it('stops cleanly', async () => {
    supervisor = new SocketSupervisor(socketPath);
    await supervisor.start();
    await supervisor.stop();
    expect(existsSync(socketPath)).toBe(false);
  });
});
