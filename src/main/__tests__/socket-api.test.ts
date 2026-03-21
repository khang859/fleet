import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketApi, type SocketCommandHandler } from '../socket-api';
import { createServer, createConnection } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

function tmpSocket(): string {
  return join(tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

describe('SocketApi', () => {
  let socketPath: string;
  let api: SocketApi;
  let handler: SocketCommandHandler;

  beforeEach(() => {
    socketPath = tmpSocket();
    handler = {
      handleCommand: vi.fn().mockResolvedValue({ ok: true, data: { message: 'hello' } })
    };
    api = new SocketApi(socketPath, handler);
  });

  afterEach(async () => {
    await api.stop();
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  it('starts and accepts a connection', async () => {
    await api.start();

    const response = await sendCommand(socketPath, { type: 'get-state', id: '1' });
    expect(response.ok).toBe(true);
  });

  it('routes commands to the handler', async () => {
    await api.start();

    await sendCommand(socketPath, { type: 'list-tabs', id: '2' });

    expect(handler.handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'list-tabs', id: '2' })
    );
  });

  it('returns error for malformed JSON', async () => {
    await api.start();

    const response = await sendRaw(socketPath, 'not json\n');
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Invalid JSON');
  });

  it('returns error response from handler', async () => {
    handler.handleCommand = vi.fn().mockResolvedValue({
      ok: false,
      error: 'pane not found: abc'
    });
    await api.start();

    const response = await sendCommand(socketPath, { type: 'focus-pane', id: '3', paneId: 'abc' });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('pane not found: abc');
  });
});

// Helper: send a JSON command and read the response
async function sendCommand(
  socketPath: string,
  cmd: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return sendRaw(socketPath, JSON.stringify(cmd) + '\n');
}

async function sendRaw(socketPath: string, data: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(data);
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1) {
        client.end();
        resolve(JSON.parse(lines[0]));
      }
    });
    client.on('error', reject);
    setTimeout(() => {
      client.end();
      reject(new Error('timeout'));
    }, 3000);
  });
}
