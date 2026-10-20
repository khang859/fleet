import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { request } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));
import { BridgeServer } from '../bridge-server';
import type { HookEvent } from '../hook-events';
import { PermissionBridge, parsePermissionAsk } from '../permission-bridge';
import type { HeldRequest } from '../permission-broker';

type Reply = { status: number; body: string };

/** Ask about a permission request as the mod does; `abort` drops it as an answer in the terminal does. */
function ask(socketPath: string, body: object): { reply: Promise<Reply>; abort: () => void } {
  let abort = (): void => {};
  const reply = new Promise<Reply>((resolve, reject) => {
    // A connection of its own, as the mod's: one kept alive in the shared agent
    // throws EPIPE with nothing listening when the server closes it after a large body.
    const req = request(
      { socketPath, path: '/permission', method: 'POST', agent: false },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
    abort = () => req.destroy();
  });
  return { reply, abort };
}

const permission = {
  request_id: 'r1',
  session_id: 's1',
  pane_id: 'pane-1',
  cwd: '/repo',
  transcript_path: '/t.jsonl',
  tool_name: 'Bash',
  tool_input: { command: 'touch a' },
  permission_suggestions: [
    { type: 'addDirectories', directories: ['/repo/x'], destination: 'session' },
    { type: 'removeRules', rules: [], behavior: 'allow', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
  ]
};

describe('parsePermissionAsk', () => {
  it('reads the request as a hook event, keeping the suggestions Fleet offers', () => {
    expect(parsePermissionAsk(JSON.stringify(permission))).toEqual({
      requestId: 'r1',
      event: expect.objectContaining({
        sessionId: 's1',
        event: 'PermissionRequest',
        status: 'waiting_for_approval',
        runtime: 'claude',
        tool: 'Bash',
        toolInput: { command: 'touch a' },
        paneId: 'pane-1',
        transcriptPath: '/t.jsonl',
        permissionSuggestions: [
          { type: 'addDirectories', directories: ['/repo/x'], destination: 'session' },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
        ]
      })
    });
  });

  it('refuses a request without its id or pane', () => {
    expect(parsePermissionAsk(JSON.stringify({ ...permission, request_id: '' }))).toBeNull();
    expect(parsePermissionAsk(JSON.stringify({ ...permission, pane_id: undefined }))).toBeNull();
    expect(parsePermissionAsk('{')).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('PermissionBridge', () => {
  let dir: string;
  let socketPath: string;
  let server: BridgeServer;
  let bridge: PermissionBridge;
  let admitted: Array<{ event: HookEvent; request: HeldRequest }>;
  let admit: boolean;
  let gone: number;

  const held = (): HeldRequest => {
    const request = admitted.at(-1)?.request;
    if (!request) throw new Error('nothing admitted');
    return request;
  };

  /**
   * Serve the bridge with these hold and grace times. Both are long unless a
   * test waits for one to run out, so a slow machine does not end a hold early.
   */
  const serve = async (holdMs = 10_000, graceMs = 10_000): Promise<void> => {
    await server.stop();
    bridge = new PermissionBridge(
      (event, request) => {
        admitted.push({ event, request });
        request.onGone(() => gone++);
        return admit;
      },
      holdMs,
      graceMs
    );
    server = new BridgeServer({ 'POST /permission': bridge }, socketPath);
    await server.start();
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-permission-bridge-'));
    socketPath = join(dir, 'bridge.sock');
    admitted = [];
    admit = true;
    gone = 0;
    server = new BridgeServer({}, socketPath);
    await serve();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds a request until Fleet answers it', async () => {
    const { reply } = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(1));

    const answer = {
      decision: 'allow' as const,
      reason: '',
      updatedPermissions: [
        { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }
      ]
    };
    expect(held().deliver(answer)).toBe(true);
    expect(await reply).toEqual({ status: 200, body: JSON.stringify(answer) });
    expect(held().deliver(answer)).toBe(false);
  });

  it('has the mod ask again after a while, admitting the request once', async () => {
    await serve(100);
    expect((await ask(socketPath, permission).reply).status).toBe(204);
    const again = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(1));

    held().deliver({ decision: 'deny', reason: 'no' });
    expect(await again.reply).toEqual({
      status: 200,
      body: JSON.stringify({ decision: 'deny', reason: 'no' })
    });
    expect(gone).toBe(0);
  });

  it('keeps an answer that came between two asks for the next one', async () => {
    await serve(100);
    expect((await ask(socketPath, permission).reply).status).toBe(204);
    expect(held().deliver({ decision: 'allow', reason: '' })).toBe(true);
    expect((await ask(socketPath, permission).reply).status).toBe(200);
  });

  it('tells Fleet the mod went away when it stops asking', async () => {
    await serve(100, 150);
    expect((await ask(socketPath, permission).reply).status).toBe(204);
    await vi.waitFor(() => expect(gone).toBe(1));
    expect(held().deliver({ decision: 'allow', reason: '' })).toBe(false);
  });

  it('tells Fleet at once when the ask is dropped, as an answer in the terminal does', async () => {
    const { reply, abort } = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(1));
    abort();
    await expect(reply).rejects.toThrow();
    await vi.waitFor(() => expect(gone).toBe(1));
  });

  it('answers 409 for a request Fleet does not hold, and when it lets one go', async () => {
    admit = false;
    expect((await ask(socketPath, permission).reply).status).toBe(409);

    admit = true;
    const { reply } = ask(socketPath, { ...permission, request_id: 'r2' });
    await vi.waitFor(() => expect(admitted).toHaveLength(2));
    held().letGo();
    expect((await reply).status).toBe(409);
    expect(gone).toBe(0);
  });

  it('answers an older ask about the same request 409 when a newer one comes', async () => {
    const first = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(1));
    const second = ask(socketPath, permission);
    expect((await first.reply).status).toBe(409);
    held().deliver({ decision: 'allow', reason: '' });
    expect((await second.reply).status).toBe(200);
    expect(admitted).toHaveLength(1);
  });

  it('forgets an answered request after a while, so the same id is a new request', async () => {
    await serve(10_000, 150);
    const first = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(1));
    held().deliver({ decision: 'allow', reason: '' });
    expect((await first.reply).status).toBe(200);
    // Kept a while: an ask now gets the same answer, and nothing new is admitted.
    expect((await ask(socketPath, permission).reply).status).toBe(200);
    expect(admitted).toHaveLength(1);

    await vi.waitFor(() => expect(bridge.asked(admitted[0].event)).toBe(false));
    const again = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(2));
    again.abort();
    await expect(again.reply).rejects.toThrow();
  });

  it('knows which tool calls the mod asked about, whatever the order of their input', async () => {
    const { reply } = ask(socketPath, {
      ...permission,
      tool_name: 'Write',
      tool_input: { file_path: '/repo/a', content: 'x' }
    });
    await vi.waitFor(() => expect(admitted).toHaveLength(1));
    const goHook = (sessionId: string, toolInput: Record<string, unknown>): HookEvent => ({
      ...admitted[0].event,
      sessionId,
      toolInput
    });
    expect(bridge.asked(goHook('s1', { content: 'x', file_path: '/repo/a' }))).toBe(true);
    expect(bridge.asked(goHook('s1', { content: 'y', file_path: '/repo/a' }))).toBe(false);
    expect(bridge.asked(goHook('s2', { content: 'x', file_path: '/repo/a' }))).toBe(false);
    held().letGo();
    expect((await reply).status).toBe(409);
  });

  it('answers a request it cannot read with 400', async () => {
    expect((await ask(socketPath, { session_id: 's1' }).reply).status).toBe(400);
    expect(admitted).toEqual([]);
  });

  it('answers a request too large to read with 413', async () => {
    const huge = { ...permission, tool_input: { content: 'x'.repeat(33 * 1024 * 1024) } };
    expect((await ask(socketPath, huge).reply).status).toBe(413);
    expect(admitted).toEqual([]);
  });

  it('answers open asks with 409 when it stops, and takes no answer after', async () => {
    const { reply } = ask(socketPath, permission);
    await vi.waitFor(() => expect(admitted).toHaveLength(1));
    await server.stop();
    expect((await reply).status).toBe(409);
    expect(held().deliver({ decision: 'allow', reason: '' })).toBe(false);
  });
});
