import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotSocketServer } from '../socket-server';
import { CopilotSessionStore } from '../session-store';

describe.skipIf(process.platform === 'win32')('CopilotSocketServer', () => {
  let dir: string;
  let socketPath: string;
  let store: CopilotSessionStore;
  let server: CopilotSocketServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-socket-'));
    socketPath = join(dir, 'copilot.sock');
    store = new CopilotSessionStore();
    server = new CopilotSocketServer(store, socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is readable and writable by its owner only', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('still accepts hook events from the owner', async () => {
    // The server is half-open and never ends its side for a plain event - the
    // real hook just exits - so the client is destroyed once the store has it.
    const client = connect(socketPath, () => {
      client.end(
        JSON.stringify({
          session_id: 's1',
          cwd: '/repo',
          event: 'Stop',
          status: 'waiting_for_input'
        })
      );
    });
    try {
      await expect.poll(() => store.getSession('s1')?.phase).toBe('waitingForInput');
    } finally {
      client.destroy();
    }
  });
});
