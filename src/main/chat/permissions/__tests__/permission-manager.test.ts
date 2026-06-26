import { describe, it, expect, vi } from 'vitest';
import { PermissionManager } from '../permission-manager';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import type {
  PermissionRequestPayload,
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
