import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'fs';
import { request } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));
import { BridgeServer } from '../bridge-server';
import { PromptBridge } from '../prompt-bridge';

type Reply = { status: number; body: string };

/** Ask the bridge as the mod does; `abort` drops the request the way an exiting Claude Code would. */
function ask(socketPath: string, path: string): { reply: Promise<Reply>; abort: () => void } {
  let abort = (): void => {};
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = request({ socketPath, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
    abort = () => req.destroy();
  });
  return { reply, abort };
}

const until = async (check: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(check()).toBe(true));

describe.skipIf(process.platform === 'win32')('PromptBridge', () => {
  let dir: string;
  let socketPath: string;
  let bridge: PromptBridge;
  let server: BridgeServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-bridge-'));
    chmodSync(dir, 0o755);
    socketPath = join(dir, 'bridge.sock');
    bridge = new PromptBridge(200);
    server = new BridgeServer({ 'GET /prompt': bridge }, socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listens on a socket only its owner can use, in a folder only its owner can enter', () => {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('holds a request for a prompt and answers it with the one delivered', async () => {
    expect(bridge.deliver('s1', 'early')).toBe(false);
    const { reply } = ask(socketPath, '/prompt?session=s1');
    await until(() => bridge.has('s1'));
    expect(bridge.has('s2')).toBe(false);

    expect(bridge.deliver('s1', 'Run the tests\nthen report')).toBe(true);
    expect(await reply).toEqual({
      status: 200,
      body: JSON.stringify({ text: 'Run the tests\nthen report' })
    });
    expect(bridge.has('s1')).toBe(false);
    expect(bridge.deliver('s1', 'again')).toBe(false);
  });

  it('answers with no prompt once the hold runs out', async () => {
    const { reply } = ask(socketPath, '/prompt?session=s1');
    expect(await reply).toEqual({ status: 204, body: '' });
    expect(bridge.has('s1')).toBe(false);
  });

  it('answers an older request with 409 when a newer one for its session comes', async () => {
    const first = ask(socketPath, '/prompt?session=s1');
    await until(() => bridge.has('s1'));
    const second = ask(socketPath, '/prompt?session=s1');
    expect((await first.reply).status).toBe(409);

    expect(bridge.deliver('s1', 'hello')).toBe(true);
    expect((await second.reply).status).toBe(200);
  });

  it('forgets a request whose mod went away', async () => {
    const { reply, abort } = ask(socketPath, '/prompt?session=s1');
    await until(() => bridge.has('s1'));
    abort();
    await expect(reply).rejects.toThrow();
    await until(() => !bridge.has('s1'));
    expect(bridge.deliver('s1', 'hello')).toBe(false);
  });

  it.each(['/prompt', '/other?session=s1'])('answers %s with 404', async (path) => {
    expect((await ask(socketPath, path).reply).status).toBe(404);
  });

  it('answers open requests and removes its socket when it stops', async () => {
    const { reply } = ask(socketPath, '/prompt?session=s1');
    await until(() => bridge.has('s1'));
    await server.stop();
    expect((await reply).status).toBe(204);
    expect(() => statSync(socketPath)).toThrow();
  });
});
