import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import type { AgentPermissionAsk } from '../../../../shared/agent-types';
import type { AgentPermissionRules } from '../../../../shared/agent-permissions';
import { PermissionGate } from '../gate';

/**
 * The gate decides in main and asks the renderer only when it has to. What is
 * being checked here is which of those two happens, and that nothing is left
 * waiting on a question that can no longer be answered.
 */

let rules: AgentPermissionRules;
let persisted: string[];
let asks: AgentPermissionAsk[];

const emit = vi.fn((channel: string, payload: unknown) => {
  if (channel === IPC_CHANNELS.AGENT_PERMISSION_ASK) asks.push(payload as AgentPermissionAsk);
});

function gate(): PermissionGate {
  return new PermissionGate({
    getRules: () => rules,
    persistAllow: (rule) => persisted.push(rule),
    emit
  });
}

const request = (
  command: string,
  signal = new AbortController().signal
): Parameters<PermissionGate['check']>[0] => ({
  streamId: 'stream-1',
  callId: 'call-1',
  command,
  signal
});

beforeEach(() => {
  rules = { allow: [], deny: [] };
  persisted = [];
  asks = [];
  emit.mockClear();
});

describe('PermissionGate', () => {
  it('runs an allowed command without disturbing anybody', async () => {
    rules.allow.push('npm run');

    await expect(gate().check(request('npm run build'))).resolves.toBe('run');
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses a denied command without disturbing anybody', async () => {
    rules.deny.push('npm publish');

    await expect(gate().check(request('npm publish'))).resolves.toBe('refuse');
    expect(emit).not.toHaveBeenCalled();
  });

  it('asks about a command no rule covers, and runs it when told to', async () => {
    const g = gate();
    const verdict = g.check(request('npm test'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));

    expect(asks[0]).toMatchObject({ command: 'npm test', callId: 'call-1', rule: 'npm test' });
    g.decide(asks[0].requestId, 'once');

    await expect(verdict).resolves.toBe('run');
    expect(persisted).toEqual([]);
  });

  it('remembers the rule when the user asks it to', async () => {
    const g = gate();
    const verdict = g.check(request('npm run build'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    g.decide(asks[0].requestId, 'always');

    await expect(verdict).resolves.toBe('run');
    expect(persisted).toEqual(['npm run']);
  });

  it('offers nothing to remember for a command that always asks', async () => {
    const g = gate();
    const verdict = g.check(request('sudo -v'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));

    expect(asks[0].rule).toBeNull();
    expect(asks[0].reason).toBe('Runs as root.');
    g.decide(asks[0].requestId, 'always');

    // Ran, because the user said so - but nothing was written down.
    await expect(verdict).resolves.toBe('run');
    expect(persisted).toEqual([]);
  });

  /*
   * A refusal answers the command, not the moment. A model that hears no and
   * calls the same thing again is not owed a second question.
   */
  it('does not ask twice about a command it was already told no about', async () => {
    const g = gate();
    const first = g.check(request('rm -rf ~/Documents'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    g.decide(asks[0].requestId, 'no');
    await expect(first).resolves.toBe('refuse');

    await expect(g.check(request('rm -rf ~/Documents'))).resolves.toBe('refuse');
    expect(asks).toHaveLength(1);
  });

  it('forgets what a turn refused once that turn is over', async () => {
    const g = gate();
    const first = g.check(request('npm test'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    g.decide(asks[0].requestId, 'no');
    await first;

    g.endTurn('stream-1');
    void g.check(request('npm test'));

    await vi.waitFor(() => expect(asks).toHaveLength(2));
  });

  it('refuses a command asked about in a turn that was already stopped', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(gate().check(request('npm test', controller.signal))).resolves.toBe('refuse');
    expect(emit).not.toHaveBeenCalled();
  });

  // Stop has to mean the command does not start, whoever gets to the question.
  it('refuses a question left on screen when the turn is stopped', async () => {
    const controller = new AbortController();
    const verdict = gate().check(request('npm test', controller.signal));
    await vi.waitFor(() => expect(asks).toHaveLength(1));

    controller.abort();

    await expect(verdict).resolves.toBe('refuse');
  });

  it('refuses a question nobody answered when the turn ends', async () => {
    const g = gate();
    const verdict = g.check(request('npm test'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));

    g.endTurn('stream-1');

    await expect(verdict).resolves.toBe('refuse');
  });

  it('ignores an answer to a question that has already been settled', async () => {
    const g = gate();
    const verdict = g.check(request('npm test'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    g.decide(asks[0].requestId, 'once');
    await verdict;

    g.decide(asks[0].requestId, 'always');

    expect(persisted).toEqual([]);
  });
});
