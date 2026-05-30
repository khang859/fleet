import { describe, it, expect, afterEach } from 'vitest';
import { createConnection } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import { SocketServer } from '../socket-server';
import type { KanbanCommands } from '../kanban/kanban-commands';

function tmpSocket(): string {
  return join(tmpdir(), `fleet-kanban-sock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

// Minimal KanbanCommands stub — only the methods the socket server calls.
function stubKanban(): KanbanCommands {
  return {
    list: () => [{ id: 't1', title: 'hello', status: 'todo' }],
    show: (id: string) => (id === 't1' ? { task: { id: 't1' }, comments: [], runs: [], events: [], parents: [], children: [] } : null)
  } as unknown as KanbanCommands;
}

async function sendOne(sockPath: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath, () => {
      socket.write(JSON.stringify({ id: 'x', command, args }) + '\n');
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.on('error', reject);
  });
}

describe('SocketServer kanban.* dispatch', () => {
  let server: SocketServer;
  let sockPath: string;

  afterEach(async () => {
    await server.stop();
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  });

  it('routes kanban.list through getKanban', async () => {
    sockPath = tmpSocket();
    server = new SocketServer(sockPath, undefined, undefined, () => stubKanban());
    await server.start();
    const res = (await sendOne(sockPath, 'kanban.list')) as { ok: boolean; data: unknown[] };
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect((res.data[0] as { title: string }).title).toBe('hello');
  });

  it('returns UNAVAILABLE when kanban is not wired', async () => {
    sockPath = tmpSocket();
    server = new SocketServer(sockPath, undefined, undefined, () => undefined);
    await server.start();
    const res = (await sendOne(sockPath, 'kanban.list')) as { ok: boolean; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('UNAVAILABLE');
  });
});

describe('SocketServer kanban.watch streaming', () => {
  let server: SocketServer;
  let sockPath: string;

  afterEach(async () => {
    await server.stop();
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  });

  it('streams broadcast events to a subscribed socket after an ack', async () => {
    sockPath = tmpSocket();
    server = new SocketServer(sockPath, undefined, undefined, () => stubKanban());
    await server.start();

    const lines = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const collected: Array<Record<string, unknown>> = [];
      const client = createConnection(sockPath, () => {
        client.write(JSON.stringify({ id: 'w', command: 'kanban.watch', args: {} }) + '\n');
      });
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const p of parts) {
          if (!p.trim()) continue;
          collected.push(JSON.parse(p));
          if (collected.length === 1) {
            // First line is the ack; now broadcast an event.
            server.broadcastKanbanEvent({ taskId: 't1', kind: 'task_created' });
          }
          if (collected.length >= 2) {
            client.end();
            resolve(collected);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('timeout'));
      }, 3000);
    });

    expect(lines[0].ok).toBe(true);
    expect((lines[0].data as { watching: boolean }).watching).toBe(true);
    expect((lines[1].kanbanEvent as { kind: string }).kind).toBe('task_created');
  });
});
