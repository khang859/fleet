import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

type Hook = (
  $: unknown,
  e: Record<string, unknown>,
  next: NextFn
) => Promise<Record<string, unknown>>;
type NextFn = ((e: unknown) => Promise<Record<string, unknown>>) & { signal: AbortSignal };
type Response = { status: number; ok: boolean; text: string };

/**
 * The mod's own module, loaded as Claude Code loads it. Not a static import:
 * its `claude-code` types exist only inside Claude Code.
 */
const MOD = join(__dirname, '../../../../resources/claude-mod/fleet-bridge/hooks/register.ts');

const reply = (status: number, body?: object): Response => ({
  status,
  ok: status >= 200 && status < 300,
  text: body ? JSON.stringify(body) : ''
});

describe('fleet-bridge mod: permission requests', () => {
  let hooks: Map<string, Hook>;
  let fetch: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>;
  let env: Record<string, string>;
  let next: NextFn;
  let abort: AbortController;

  const $ = {
    env: { get: async (name: string) => Promise.resolve(env[name]) },
    http: { fetch: async (...args: unknown[]): Promise<Response> => fetch(...args) },
    clock: { after: vi.fn() },
    session: { id: async () => Promise.resolve('s1') }
  };

  const request = {
    session_id: 's1',
    cwd: '/repo',
    transcript_path: '/t.jsonl',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'touch a' },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  };

  const permissionHook = (): Hook => {
    const hook = hooks.get('classic.PermissionRequest');
    if (!hook) throw new Error('no PermissionRequest hook');
    return hook;
  };

  beforeEach(async () => {
    hooks = new Map();
    fetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
    env = { FLEET_BRIDGE_SOCKET: '/s.sock', FLEET_PANE_ID: 'pane-1' };
    abort = new AbortController();
    next = Object.assign(
      vi.fn(async () => Promise.resolve({ fromGoHook: true })),
      { signal: abort.signal }
    );
    const { register } = (await import(/* @vite-ignore */ MOD)) as {
      register: (on: (name: string, hook: Hook) => { catch: () => void }) => void;
    };
    register((name, hook) => {
      hooks.set(name, hook);
      return { catch: () => {} };
    });
    const start = hooks.get('session.start');
    await start?.(
      $,
      { isInteractive: true },
      Object.assign(async () => Promise.resolve({}), { signal: abort.signal })
    );
  });

  it('asks Fleet until it answers, and allows with the suggestion it picked', async () => {
    const updatedPermissions = request.permission_suggestions;
    fetch
      .mockResolvedValueOnce(reply(204))
      .mockResolvedValueOnce(reply(200, { decision: 'allow', reason: '', updatedPermissions }));

    await expect(permissionHook()($, request, next)).resolves.toEqual({
      decision: { behavior: 'allow', updatedPermissions }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0] as [string, { body: string; socketPath: string }];
    expect(url).toBe('http://fleet/permission');
    expect(init.socketPath).toBe('/s.sock');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ session_id: 's1', pane_id: 'pane-1', tool_name: 'Bash' });
    // Every ask names the same request.
    expect((fetch.mock.calls[1] as [string, { body: string }])[1].body).toBe(init.body);
    expect(next).not.toHaveBeenCalled();
  });

  it('denies with the reason Fleet gave', async () => {
    fetch.mockResolvedValueOnce(reply(200, { decision: 'deny', reason: 'not now' }));
    await expect(permissionHook()($, request, next)).resolves.toEqual({
      decision: { behavior: 'deny', message: 'not now' }
    });
  });

  it('leaves a request Fleet will not answer to the dialog, without the Go hook', async () => {
    fetch.mockResolvedValueOnce(reply(409));
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    expect(next).not.toHaveBeenCalled();
  });

  it('hands the request to the Go hook when Fleet cannot take it', async () => {
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(permissionHook()($, request, next)).resolves.toEqual({ fromGoHook: true });
    fetch.mockResolvedValueOnce(reply(404));
    await expect(permissionHook()($, request, next)).resolves.toEqual({ fromGoHook: true });
  });

  it('stops quietly once the request is answered in the terminal', async () => {
    fetch.mockImplementationOnce(async () => {
      abort.abort();
      return Promise.reject(new Error('aborted'));
    });
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves a question, or a pane without a Fleet pane id, to the Go hook', async () => {
    await permissionHook()($, { ...request, tool_name: 'AskUserQuestion' }, next);
    delete env.FLEET_PANE_ID;
    await permissionHook()($, request, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
