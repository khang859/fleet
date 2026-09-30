import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { connect, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookServer, PermissionBroker } from '../hook-server';
import type { HookEvent } from '../hook-events';

/** Send one event the way the Go hook does, and collect whatever comes back. */
async function sendEvent(socketPath: string, event: object): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    const client = connect(socketPath, () => client.end(JSON.stringify(event)));
    client.on('data', (chunk) => (reply += chunk.toString()));
    client.on('close', () => resolve(reply));
    client.on('error', reject);
  });
}

const stop = { session_id: 's1', cwd: '/repo', event: 'Stop', status: 'waiting_for_input' };
const permission = {
  session_id: 's1',
  cwd: '/repo',
  event: 'PermissionRequest',
  status: 'waiting_for_approval',
  tool: 'Bash',
  tool_use_id: 'tu-1'
};

describe.skipIf(process.platform === 'win32')('HookServer', () => {
  let dir: string;
  let socketPath: string;
  let received: HookEvent[];
  let released: Array<[string, string]>;
  let broker: PermissionBroker;
  let server: HookServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-hook-server-'));
    socketPath = join(dir, 'hook.sock');
    received = [];
    released = [];
    broker = new PermissionBroker(
      (sessionId, toolUseId) => released.push([sessionId, toolUseId]),
      200
    );
    server = new HookServer((event: HookEvent, client: Socket) => {
      received.push(event);
      if (event.status !== 'waiting_for_approval' || !event.toolUseId) return false;
      broker.hold(event.sessionId, event.toolUseId, client);
      return true;
    }, socketPath);
    await server.start();
  });

  afterEach(async () => {
    await broker.dispose();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is readable and writable by its owner only', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('parses an event and closes the connection', async () => {
    await expect(sendEvent(socketPath, stop)).resolves.toBe('');
    expect(received).toEqual([expect.objectContaining({ sessionId: 's1', event: 'Stop' })]);
  });

  it('closes the connection on an invalid event without calling the handler', async () => {
    await expect(sendEvent(socketPath, { nope: true })).resolves.toBe('');
    expect(received).toEqual([]);
  });

  it('holds a permission request until it is answered', async () => {
    const reply = sendEvent(socketPath, permission);
    await vi.waitFor(() => expect(broker.has('tu-1')).toBe(true));

    expect(broker.respond('tu-1', 'deny', 'not now')).toBe(true);
    expect(JSON.parse(await reply)).toEqual({ decision: 'deny', reason: 'not now' });
    expect(released).toEqual([['s1', 'tu-1']]);
    expect(broker.has('tu-1')).toBe(false);
  });

  it('releases a held permission once the hook has waited out its time', async () => {
    const reply = sendEvent(socketPath, permission);
    await vi.waitFor(() => expect(broker.has('tu-1')).toBe(true));

    await vi.waitFor(() => expect(released).toEqual([['s1', 'tu-1']]));
    await expect(reply).resolves.toBe('');
    expect(broker.respond('tu-1', 'allow')).toBe(false);
  });

  it('drops a held permission the session no longer lists, without reporting it', async () => {
    const reply = sendEvent(socketPath, permission);
    await vi.waitFor(() => expect(broker.has('tu-1')).toBe(true));

    broker.retainOnly('other-session', new Set());
    expect(broker.has('tu-1')).toBe(true);
    broker.retainOnly('s1', new Set());
    expect(broker.has('tu-1')).toBe(false);
    await expect(reply).resolves.toBe('');
    expect(released).toEqual([]);
  });

  it('removes the socket file on stop', async () => {
    await server.stop();
    expect(() => statSync(socketPath)).toThrow();
  });
});
