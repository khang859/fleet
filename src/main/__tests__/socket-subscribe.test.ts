import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketApi, type SocketCommandHandler } from '../socket-api';
import { createConnection } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

function tmpSocket(): string {
  return join(tmpdir(), `fleet-sub-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('SocketApi subscriptions', () => {
  let socketPath: string;
  let api: SocketApi;

  beforeEach(async () => {
    socketPath = tmpSocket();
    const handler: SocketCommandHandler = {
      handleCommand: vi.fn().mockResolvedValue({ ok: true })
    };
    api = new SocketApi(socketPath, handler);
    await api.start();
  });

  afterEach(async () => {
    await api.stop();
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  it('receives broadcast events after subscribing', async () => {
    const messages = await new Promise<string[]>((resolve, reject) => {
      const collected: string[] = [];
      const client = createConnection(socketPath, () => {
        client.write(JSON.stringify({ type: 'subscribe', events: ['notification'] }) + '\n');
      });

      client.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        collected.push(...lines);

        // First message is the subscribe ack
        if (collected.length === 1) {
          // Trigger a broadcast
          api.broadcastEvent('notification', { paneId: 'p1', level: 'info', timestamp: 1 });
        }

        // Second message should be the broadcast
        if (collected.length >= 2) {
          client.end();
          resolve(collected);
        }
      });

      setTimeout(() => {
        client.end();
        reject(new Error('timeout'));
      }, 3000);
    });

    expect(messages).toHaveLength(2);

    const ack = JSON.parse(messages[0]);
    expect(ack.ok).toBe(true);

    const event = JSON.parse(messages[1]);
    expect(event.event).toBe('notification');
    expect(event.paneId).toBe('p1');
  });

  it('does not receive events for unsubscribed types', async () => {
    const messages = await new Promise<string[]>((resolve) => {
      const collected: string[] = [];
      const client = createConnection(socketPath, () => {
        client.write(JSON.stringify({ type: 'subscribe', events: ['pane-created'] }) + '\n');
      });

      client.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        collected.push(...lines);

        if (collected.length === 1) {
          // Broadcast a notification event (not subscribed)
          api.broadcastEvent('notification', { paneId: 'p1', level: 'info', timestamp: 1 });
          // Give time for potential delivery, then close
          setTimeout(() => {
            client.end();
            resolve(collected);
          }, 200);
        }
      });

      setTimeout(() => {
        client.end();
        resolve(collected);
      }, 3000);
    });

    // Should only have the subscribe ack, not the notification
    expect(messages).toHaveLength(1);
  });
});
