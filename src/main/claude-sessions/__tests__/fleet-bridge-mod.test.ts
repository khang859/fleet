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
  let catches: Map<string, Hook>;
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
    catches = new Map();
    fetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
    env = { FLEET_BRIDGE_SOCKET: '/s.sock', FLEET_PANE_ID: 'pane-1' };
    abort = new AbortController();
    next = Object.assign(
      vi.fn(async () => Promise.resolve({ fromGoHook: true })),
      { signal: abort.signal }
    );
    const { register } = (await import(/* @vite-ignore */ MOD)) as {
      register: (on: (name: string, hook: Hook) => { catch: (handler: Hook) => void }) => void;
    };
    register((name, hook) => {
      hooks.set(name, hook);
      return { catch: (handler) => catches.set(name, handler) };
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

  it('allows a plan with its input, which the plan dialog needs to close', async () => {
    const plan = {
      ...request,
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '1. Create hello.txt', planFilePath: '/plans/p.md' },
      permission_suggestions: undefined
    };
    fetch.mockResolvedValueOnce(reply(200, { decision: 'allow', reason: '' }));

    await expect(permissionHook()($, plan, next)).resolves.toEqual({
      decision: { behavior: 'allow', updatedInput: plan.tool_input }
    });
  });

  it('denies with the reason Fleet gave', async () => {
    fetch.mockResolvedValueOnce(reply(200, { decision: 'deny', reason: 'not now' }));
    await expect(permissionHook()($, request, next)).resolves.toEqual({
      decision: { behavior: 'deny', message: 'not now' }
    });
  });

  it('passes a request Fleet will not answer on to the settings hooks', async () => {
    fetch.mockResolvedValueOnce(reply(409));
    await expect(permissionHook()($, request, next)).resolves.toEqual({ fromGoHook: true });
  });

  it('leaves the request to the dialog when Fleet answers with nothing it can read', async () => {
    fetch.mockResolvedValueOnce({ status: 200, ok: true, text: 'not json' });
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    fetch.mockResolvedValueOnce(reply(200, { decision: 'maybe', reason: '' }));
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    fetch.mockResolvedValueOnce({ status: 200, ok: true, text: 'null' });
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    expect(next).not.toHaveBeenCalled();
  });

  it('hands the request to the Go hook when Fleet cannot take it', async () => {
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(permissionHook()($, request, next)).resolves.toEqual({ fromGoHook: true });
    fetch.mockResolvedValueOnce(reply(404));
    await expect(permissionHook()($, request, next)).resolves.toEqual({ fromGoHook: true });
  });

  it('does not ask again once the request is answered in the terminal between two asks', async () => {
    fetch.mockImplementationOnce(async () => {
      abort.abort();
      return Promise.resolve(reply(204));
    });
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('hands a hook that failed to the settings hooks, unless it was settled', async () => {
    const onFailure = catches.get('classic.PermissionRequest');
    if (!onFailure) throw new Error('no catch handler');
    await expect(onFailure($, request, next)).resolves.toEqual({ fromGoHook: true });
    const called = Object.assign(vi.fn(), { signal: abort.signal, called: true });
    await expect(onFailure($, request, called)).resolves.toEqual({});
    expect(called).not.toHaveBeenCalled();
  });

  it('stops quietly once the request is answered in the terminal', async () => {
    fetch.mockImplementationOnce(async () => {
      abort.abort();
      return Promise.reject(new Error('aborted'));
    });
    await expect(permissionHook()($, request, next)).resolves.toEqual({});
    expect(next).not.toHaveBeenCalled();
  });

  describe('the id of the call it asks about', () => {
    const hook = (name: string): Hook => {
      const found = hooks.get(name);
      if (!found) throw new Error(`no ${name} hook`);
      return found;
    };

    const nextOf = (result: Record<string, unknown>): NextFn =>
      Object.assign(async () => Promise.resolve(result), { signal: abort.signal });

    /** `tool.check` for the request's call, as Claude Code runs it before the dialog. */
    const check = async (id: string, decision = 'ask'): Promise<void> => {
      await hook('tool.check')(
        $,
        { tool: 'Bash', input: request.tool_input, tool_use_id: id },
        nextOf({ decision })
      );
    };

    /** The `tool_use_id` the mod sent Fleet for one permission request. */
    const askedId = async (e: Record<string, unknown> = request): Promise<unknown> => {
      fetch.mockResolvedValueOnce(reply(200, { decision: 'allow', reason: '' }));
      await permissionHook()($, e, next);
      const [, init] = fetch.mock.calls.at(-1) as [string, { body: string }];
      return (JSON.parse(init.body) as Record<string, unknown>).tool_use_id;
    };

    it('sends the id of the call its check put to the dialog', async () => {
      await check('toolu_1');
      await expect(askedId()).resolves.toBe('toolu_1');
    });

    it('hands two asks of the same call their ids in order', async () => {
      await check('toolu_1');
      await check('toolu_2');
      await expect(askedId()).resolves.toBe('toolu_1');
      await expect(askedId()).resolves.toBe('toolu_2');
      await expect(askedId()).resolves.toBeUndefined();
    });

    it('sends no id for a call its check allowed, or for another input', async () => {
      await check('toolu_1', 'allow');
      await expect(askedId()).resolves.toBeUndefined();
      await check('toolu_2');
      await expect(askedId({ ...request, tool_input: { command: 'touch b' } })).resolves.toBe(
        undefined
      );
    });

    it('keeps apart the same call in a subagent', async () => {
      await hook('tool.check')(
        $,
        { tool: 'Bash', input: request.tool_input, tool_use_id: 'toolu_sub', agentId: 'a1' },
        nextOf({ decision: 'ask' })
      );
      await check('toolu_main');
      await expect(askedId()).resolves.toBe('toolu_main');
      await expect(askedId({ ...request, agent_id: 'a1' })).resolves.toBe('toolu_sub');
    });

    it('forgets the id of an ask no dialog took once its call ends', async () => {
      await check('toolu_1');
      await hook('tool.call')($, { tool: 'Bash', tool_use_id: 'toolu_1' }, nextOf({}));
      await check('toolu_2');
      await expect(askedId()).resolves.toBe('toolu_2');
    });

    it('forgets the id when the call fails too', async () => {
      await check('toolu_1');
      const failing = Object.assign(async () => Promise.reject(new Error('tool failed')), {
        signal: abort.signal
      });
      await expect(
        hook('tool.call')($, { tool: 'Bash', tool_use_id: 'toolu_1' }, failing)
      ).rejects.toThrow('tool failed');
      await expect(askedId()).resolves.toBeUndefined();
    });

    it('takes the id of a request it leaves to the Go hook, so the next one gets its own', async () => {
      const question = { ...request, tool_name: 'AskUserQuestion' };
      await hook('tool.check')(
        $,
        { tool: 'AskUserQuestion', input: request.tool_input, tool_use_id: 'toolu_q' },
        nextOf({ decision: 'ask' })
      );
      await permissionHook()($, question, next);
      await check('toolu_1');
      await expect(askedId()).resolves.toBe('toolu_1');
    });
  });

  it('leaves a question, or a pane without a Fleet pane id, to the Go hook', async () => {
    await permissionHook()($, { ...request, tool_name: 'AskUserQuestion' }, next);
    delete env.FLEET_PANE_ID;
    await permissionHook()($, request, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
