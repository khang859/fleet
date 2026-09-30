import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionChange } from '../../../../shared/claude-sessions';
import { FLEET_CHAIN_LIMIT, type FleetAsk } from '../../../../shared/fleet-tools';
import { PromptInput } from '../../../claude-sessions/input';
import type { FleetHost, FleetSession } from '../host';
import { FleetLedgerStore } from '../ledger-store';
import { ACT_LIMIT, ACT_WINDOW_MS, ActLimiter } from '../limiter';
import { sendToSession } from '../send';

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const ARGS = {
  session: 'abcdef12',
  prompt: 'Run the tests',
  why: 'the refactor is done',
  expect: 'a pass or the failing test names'
};

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: 's1',
    paneId: 'abcdef12-pane',
    ref: 'abcdef12',
    label: 'fleet › api',
    epoch: 2,
    cwd: '/work',
    projectName: 'work',
    phase: 'waitingForInput',
    waitingKind: 'prompt',
    phaseSince: 0,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0,
    usage: { costUsd: null, contextTokens: null, contextLimit: null },
    git: null,
    ...over
  };
}

describe('fleet_send', () => {
  let dir: string;
  let now: number;
  let current: FleetSession;
  let writes: string[];
  let noted: string[];
  let asks: FleetAsk[];
  let answer: boolean;
  let listeners: Set<(change: ClaudeSessionChange) => void>;
  let input: PromptInput;
  let ledger: FleetLedgerStore;
  let limiter: ActLimiter;

  const host = (): FleetHost => ({
    tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
    sessions: () => [current],
    starting: () => [],
    transcript: async () => Promise.resolve(null),
    inputsFor: () => [],
    git: async () => Promise.reject(new Error('unused')),
    now: () => now
  });

  const approve = async (ask: FleetAsk): Promise<boolean> => {
    asks.push(ask);
    return Promise.resolve(answer);
  };

  const send = async (args = ARGS): Promise<{ text: string; summary: string }> =>
    sendToSession(
      {
        host: host(),
        ledger,
        limiter,
        prompter: {
          refusal: (id) => input.refusal(id),
          send: async (id, text) => input.send(id, text, 'orchestrator')
        }
      },
      THREAD,
      args,
      approve
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-send-'));
    now = 1_000_000;
    current = session();
    writes = [];
    noted = [];
    asks = [];
    answer = true;
    listeners = new Set();
    ledger = new FleetLedgerStore(dir);
    limiter = new ActLimiter();
    input = new PromptInput({
      session: (id) => (id === current.sessionId ? current : undefined),
      noteInput: (_id, origin, text) => noted.push(`${origin}: ${text}`),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      write: (_pane, data) => {
        writes.push(data);
        if (data !== '\r') return;
        for (const l of [...listeners]) {
          l({
            sessionId: 's1',
            session: current,
            event: {
              seq: 1,
              sessionId: 's1',
              at: now,
              event: 'UserPromptSubmit',
              status: '',
              phase: 'processing'
            }
          });
        }
      },
      now: () => now,
      sleep: async () => Promise.resolve()
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asks, then types the prompt with its prefix and writes it in the ledger', async () => {
    const out = await send();
    expect(asks).toEqual([
      {
        action: 'send',
        sessionId: 's1',
        target: 'abcdef12 (fleet › api)',
        prompt: '[orchestrator] Run the tests'
      }
    ]);
    expect(writes).toEqual(['[orchestrator] Run the tests', '\r']);
    expect(noted).toEqual(['orchestrator: [orchestrator] Run the tests']);
    expect(ledger.entries(THREAD)).toEqual([
      expect.objectContaining({
        id: '#1',
        action: 'send',
        ref: 'abcdef12',
        sessionId: 's1',
        epoch: 2,
        prompt: '[orchestrator] Run the tests',
        why: 'the refactor is done',
        expect: 'a pass or the failing test names',
        at: now,
        started: true,
        state: 'open'
      })
    ]);
    expect(out.text).toContain('Sent to abcdef12 as ledger entry #1.');
    expect(out.summary).toBe('sent to abcdef12');
  });

  it('refuses without asking once Fleet has woken the conversation too many times in a row', async () => {
    for (let i = 0; i < FLEET_CHAIN_LIMIT; i++) ledger.extendChain(THREAD);
    await expect(send()).rejects.toThrow('sends and spawns are paused until they write');
    expect(asks).toEqual([]);
    ledger.resetChain(THREAD);
    await expect(send()).resolves.toMatchObject({ summary: 'sent to abcdef12' });
  });

  it('writes nothing when the user says no', async () => {
    answer = false;
    await expect(send()).rejects.toThrow('The user did not let this prompt be sent.');
    expect(writes).toEqual([]);
    expect(ledger.entries(THREAD)).toEqual([]);
  });

  it('does not ask about a prompt that could not go in', async () => {
    current = session({ phase: 'processing', waitingKind: null });
    await expect(send()).rejects.toThrow('Not sent: it is working on a turn.');
    input.onUserInput('abcdef12-pane', 'half a thought');
    current = session();
    await expect(send()).rejects.toThrow('typed text in that pane');
    input.onUserInput('abcdef12-pane', '\x15');
    now += 3_000;
    await expect(send({ ...ARGS, prompt: 'see C:\\' })).rejects.toThrow('line break');
    await expect(send({ ...ARGS, session: 'nope' })).rejects.toThrow('No session has the ref');
    expect(asks).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('checks again after the user answers, since they may have started typing', async () => {
    answer = true;
    const typing = async (ask: FleetAsk): Promise<boolean> => {
      asks.push(ask);
      input.onUserInput('abcdef12-pane', 'x');
      return Promise.resolve(true);
    };
    await expect(
      sendToSession(
        {
          host: host(),
          ledger,
          limiter,
          prompter: {
            refusal: (id) => input.refusal(id),
            send: async (id, text) => input.send(id, text, 'orchestrator')
          }
        },
        THREAD,
        ARGS,
        typing
      )
    ).rejects.toThrow('typed text in that pane');
    expect(writes).toEqual([]);
    expect(ledger.entries(THREAD)).toEqual([]);
  });

  it(`refuses the ${ACT_LIMIT + 1}th prompt in ${ACT_WINDOW_MS / 60_000} minutes without asking`, async () => {
    for (let i = 0; i < ACT_LIMIT; i++) {
      await send();
      now += 1_000;
    }
    asks = [];
    await expect(send()).rejects.toThrow(
      `made ${ACT_LIMIT} sends and spawns in the last 10 minutes`
    );
    expect(asks).toEqual([]);
    now = 1_000_000 + ACT_WINDOW_MS;
    await expect(send()).resolves.toMatchObject({ summary: 'sent to abcdef12' });
  });

  it('keeps the limit per conversation', () => {
    const limits = new ActLimiter();
    for (let i = 0; i < ACT_LIMIT; i++) limits.note('a', i);
    expect(limits.refusal('a', ACT_LIMIT)).toContain('in about 10 minutes');
    expect(limits.refusal('a', ACT_WINDOW_MS)).toBeNull();
    expect(limits.refusal('b', ACT_LIMIT)).toBeNull();
  });
});
