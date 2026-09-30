import { beforeEach, describe, expect, it } from 'vitest';
import type { ClaudePendingPermission } from '../../../../shared/claude-sessions';
import type { FleetAsk, FleetPermissionArgs } from '../../../../shared/fleet-tools';
import type { FleetHost, FleetSession } from '../host';
import { answerPermission } from '../permission';

function pending(toolUseId: string, command: string): ClaudePendingPermission {
  return {
    sessionId: 's1',
    toolUseId,
    tool: { toolName: 'Bash', toolInput: { command, description: 'Install' } },
    receivedAt: 0
  };
}

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: 's1',
    paneId: 'abcdef12-pane',
    ref: 'abcdef12',
    label: 'fleet › api',
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'waitingForApproval',
    waitingKind: null,
    phaseSince: 0,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [pending('tu-1', 'npm install left-pad')],
    lastActivity: 0,
    createdAt: 0,
    usage: { costUsd: null, contextTokens: null, contextLimit: null },
    git: null,
    ...over
  };
}

describe('fleet_permission', () => {
  let current: FleetSession;
  let held: Set<string>;
  let answered: Array<[string, string, string | undefined]>;
  let asks: FleetAsk[];
  let answer: boolean;

  const host = (): FleetHost => ({
    tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
    sessions: () => [current],
    starting: () => [],
    transcript: async () => Promise.resolve(null),
    inputsFor: () => [],
    git: async () => Promise.reject(new Error('unused')),
    now: () => 0
  });

  const run = async (
    args: FleetPermissionArgs = { session: 'abcdef12', decision: 'allow' }
  ): Promise<{ text: string; summary: string }> =>
    answerPermission(
      {
        host: host(),
        answers: {
          held: (id) => held.has(id),
          respond: (id, decision, reason) => {
            if (!held.delete(id)) return false;
            answered.push([id, decision, reason]);
            return true;
          }
        }
      },
      args,
      async (ask) => {
        asks.push(ask);
        return Promise.resolve(answer);
      }
    );

  beforeEach(() => {
    current = session();
    held = new Set(['tu-1']);
    answered = [];
    asks = [];
    answer = true;
  });

  it('asks with the command and its folder, then answers the held request', async () => {
    const out = await run();
    expect(asks).toEqual([
      {
        action: 'permission',
        sessionId: 's1',
        target: 'abcdef12 (fleet › api)',
        prompt: 'Bash: npm install left-pad',
        decision: 'allow',
        command: 'npm install left-pad',
        cwd: '/work'
      }
    ]);
    expect(answered).toEqual([['tu-1', 'allow', undefined]]);
    expect(out.summary).toBe('Bash: npm install left-pad');
    expect(out.text).toContain('<session-data session="abcdef12">\nBash: npm install left-pad');
  });

  it('tells the session who denied it and why', async () => {
    await run({ session: 'abcdef12', decision: 'deny', reason: 'not in scope' });
    expect(answered).toEqual([['tu-1', 'deny', 'Denied by the Fleet Orchestrator: not in scope']]);
  });

  it('answers the oldest request and says how many are left', async () => {
    current = session({
      pendingPermissions: [pending('tu-1', 'npm test'), pending('tu-2', 'npm run lint')]
    });
    const out = await run();
    expect(answered[0][0]).toBe('tu-1');
    expect(out.text).toContain('It has 1 more waiting');
  });

  it('shows another tool its whole input, with no command for the rules', async () => {
    current = session({
      pendingPermissions: [
        {
          sessionId: 's1',
          toolUseId: 'tu-1',
          tool: { toolName: 'Write', toolInput: { file_path: '/work/a.ts', content: 'x' } },
          receivedAt: 0
        }
      ]
    });
    await run();
    expect(asks[0]).toMatchObject({ command: null, prompt: expect.stringContaining('"content"') });
  });

  it('refuses before asking when there is nothing to answer, or Fleet is not holding it', async () => {
    current = session({ phase: 'processing', pendingPermissions: [] });
    await expect(run()).rejects.toThrow('not waiting on a permission request');
    current = session();
    held.clear();
    await expect(run()).rejects.toThrow('only the user can answer it');
    expect(asks).toEqual([]);
  });

  it('leaves the request alone when the user says no', async () => {
    answer = false;
    await expect(run()).rejects.toThrow('the user did not let you allow this request');
    expect(answered).toEqual([]);
    expect(held.has('tu-1')).toBe(true);
  });

  it('says so when the request went away while the user was asked', async () => {
    const approveThenLose = answerPermission(
      {
        host: host(),
        answers: { held: () => true, respond: () => false }
      },
      { session: 'abcdef12', decision: 'allow' },
      async () => Promise.resolve(true)
    );
    await expect(approveThenLose).rejects.toThrow('answered or withdrawn');
  });
});
