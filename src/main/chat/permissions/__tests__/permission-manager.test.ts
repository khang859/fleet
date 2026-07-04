import { describe, it, expect, vi } from 'vitest';
import { PermissionManager } from '../permission-manager';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import type {
  PermissionRequestPayload,
  PermissionResolvedPayload,
  PermissionRules
} from '../../../../shared/chat-permissions';

const baseRules: PermissionRules = { allow: [], ask: [], deny: [] };

function makeManager(overrides: Partial<PermissionRules> = {}) {
  const rules = { ...baseRules, ...overrides };
  const persisted: string[] = [];
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const mgr = new PermissionManager({
    getRules: () => rules,
    persistAllowRule: (rule) => persisted.push(rule),
    emit: (channel, payload) => emitted.push({ channel, payload })
  });
  return { mgr, rules, persisted, emitted };
}

// Like makeManager, but persistAllowRule mutates the live rule set (as the real
// settings-backed persist does), so retro-apply can see the newly added rule.
function makeMutableManager(overrides: Partial<PermissionRules> = {}) {
  const rules: PermissionRules = { allow: [], ask: [], deny: [], ...overrides };
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const mgr = new PermissionManager({
    getRules: () => rules,
    persistAllowRule: (rule) => {
      if (!rules.allow.includes(rule)) rules.allow.push(rule);
    },
    emit: (channel, payload) => emitted.push({ channel, payload })
  });
  const reqPayloads = (): PermissionRequestPayload[] =>
    emitted
      .filter((e) => e.channel === IPC_CHANNELS.CHAT_PERMISSION_REQUEST)
      .map((e) => e.payload as PermissionRequestPayload);
  const resolvedPayloads = (): PermissionResolvedPayload[] =>
    emitted
      .filter((e) => e.channel === IPC_CHANNELS.CHAT_PERMISSION_RESOLVED)
      .map((e) => e.payload as PermissionResolvedPayload);
  return { mgr, rules, emitted, reqPayloads, resolvedPayloads };
}

describe('PermissionManager', () => {
  it('auto-allows without reaching the renderer when a rule allows', async () => {
    const { mgr, emitted } = makeManager({ allow: ['Bash(ls *)'] });
    const grant = await mgr.request({ streamId: 's', tool: 'Bash', command: 'ls -la' });
    expect(grant).toBe('allow');
    expect(emitted).toHaveLength(0);
  });

  it('auto-denies without reaching the renderer when a rule denies', async () => {
    const { mgr, emitted } = makeManager({ deny: ['Bash(rm *)'] });
    const grant = await mgr.request({ streamId: 's', tool: 'Bash', command: 'rm -rf x' });
    expect(grant).toBe('deny');
    expect(emitted).toHaveLength(0);
  });

  it('round-trips an ask: emits a request, resolves on the decision', async () => {
    const { mgr, emitted } = makeManager();
    const pending = mgr.request({ streamId: 's', tool: 'Bash', command: 'curl example.com' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channel).toBe(IPC_CHANNELS.CHAT_PERMISSION_REQUEST);
    const payload = emitted[0].payload as PermissionRequestPayload;
    expect(payload.command).toBe('curl example.com');
    expect(payload.rememberPrefix).toBe('curl example.com');

    mgr.decide(payload.requestId, 'allow-once');
    expect(await pending).toBe('allow');
  });

  it('persists a permanent rule on allow-always', async () => {
    const { mgr, emitted, persisted } = makeManager();
    const pending = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const payload = emitted[0].payload as PermissionRequestPayload;
    mgr.decide(payload.requestId, 'allow-always');
    expect(await pending).toBe('allow');
    expect(persisted).toEqual(['Bash(npm run *)']);
  });

  it('resolves deny on a deny decision and persists nothing', async () => {
    const { mgr, emitted, persisted } = makeManager();
    const pending = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const payload = emitted[0].payload as PermissionRequestPayload;
    mgr.decide(payload.requestId, 'deny');
    expect(await pending).toBe('deny');
    expect(persisted).toEqual([]);
  });

  it('an aborted signal resolves to deny', async () => {
    const { mgr } = makeManager();
    const ac = new AbortController();
    const pending = mgr.request({
      streamId: 's',
      tool: 'Bash',
      command: 'sleep 100',
      signal: ac.signal
    });
    ac.abort();
    expect(await pending).toBe('deny');
  });

  it('ignores a decision for an unknown / already-settled request', () => {
    const { mgr } = makeManager();
    expect(() => mgr.decide('nope', 'allow-once')).not.toThrow();
  });
});

// Guard against accidental double-resolution of a pending promise.
it('decide is idempotent after settling', async () => {
  const persisted: string[] = [];
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const mgr = new PermissionManager({
    getRules: () => ({ allow: [], ask: [], deny: [] }),
    persistAllowRule: (r) => persisted.push(r),
    emit: (c, p) => emitted.push({ channel: c, payload: p })
  });
  const resolved = vi.fn();
  const pending = mgr.request({ streamId: 's', tool: 'Bash', command: 'x' }).then(resolved);
  const payload = emitted[0].payload as PermissionRequestPayload;
  mgr.decide(payload.requestId, 'allow-once');
  mgr.decide(payload.requestId, 'deny'); // no-op
  await pending;
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(resolved).toHaveBeenCalledWith('allow');
});

describe('PermissionManager retro-apply', () => {
  it('allow-always resolves other queued requests the new rule now covers', async () => {
    const { mgr, reqPayloads, resolvedPayloads } = makeMutableManager();
    const p1 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const p2 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run test' });
    const [first, second] = reqPayloads();

    mgr.decide(first.requestId, 'allow-always'); // persists Bash(npm run *)

    expect(await p1).toBe('allow');
    expect(await p2).toBe('allow'); // auto-resolved, never re-prompted
    const resolved = resolvedPayloads();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].requestId).toBe(second.requestId);
    expect(resolved[0].streamId).toBe('s');
  });

  it('leaves queued requests the new rule does not cover still pending', async () => {
    const { mgr, reqPayloads, resolvedPayloads } = makeMutableManager();
    const p1 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const p2 = mgr.request({ streamId: 's', tool: 'Bash', command: 'git push' });
    const [first, second] = reqPayloads();

    mgr.decide(first.requestId, 'allow-always'); // Bash(npm run *) does not cover git push

    expect(await p1).toBe('allow');
    expect(resolvedPayloads()).toHaveLength(0);
    // p2 is still pending: deciding it explicitly still works.
    mgr.decide(second.requestId, 'deny');
    expect(await p2).toBe('deny');
  });

  it('allow-once does not retro-apply to the queue', async () => {
    const { mgr, reqPayloads, resolvedPayloads } = makeMutableManager();
    const p1 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run build' });
    const p2 = mgr.request({ streamId: 's', tool: 'Bash', command: 'npm run test' });
    const [first, second] = reqPayloads();

    mgr.decide(first.requestId, 'allow-once'); // persists nothing

    expect(await p1).toBe('allow');
    expect(resolvedPayloads()).toHaveLength(0);
    mgr.decide(second.requestId, 'deny');
    expect(await p2).toBe('deny');
  });
});
