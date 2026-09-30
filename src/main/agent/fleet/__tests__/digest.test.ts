import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionChange } from '../../../../shared/claude-sessions';
import { FLEET_CHAIN_LIMIT } from '../../../../shared/fleet-tools';
import { BriefBuilder } from '../../../claude-sessions/brief';
import type { SessionTranscript } from '../../../claude-sessions/session-transcripts';
import { TranscriptTail } from '../../../claude-sessions/transcript';
import { FleetAttention } from '../attention';
import { pullDigest } from '../digest';
import type { FleetHost, FleetSession } from '../host';
import { FleetLedgerStore } from '../ledger-store';
import { chainRefusal } from '../limiter';

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const NOW = Date.parse('2026-09-30T10:10:00Z');

const line = (o: object): string => `${JSON.stringify(o)}\n`;
const prompt = (uuid: string, text: string): string =>
  line({
    type: 'user',
    uuid,
    timestamp: '2026-09-30T10:00:00.000Z',
    origin: { kind: 'human' },
    message: { role: 'user', content: text }
  });
const reply = (uuid: string, text: string): string =>
  line({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  });

function session(n: number, over: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: `s${n}`,
    paneId: `pane000${n}-x`,
    ref: `pane000${n}`,
    label: `work › tab ${n}`,
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'processing',
    waitingKind: null,
    phaseSince: NOW - 60_000,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: NOW,
    createdAt: 0,
    usage: { costUsd: null, contextTokens: null, contextLimit: null },
    git: null,
    ...over
  };
}

const finished = (n: number, over: Partial<FleetSession> = {}): FleetSession =>
  session(n, { phase: 'waitingForInput', waitingKind: 'prompt', phaseSince: NOW - 1_000, ...over });

describe('pullDigest', () => {
  let dir: string;
  let sessions: FleetSession[];
  let transcripts: Map<string, SessionTranscript>;
  let ledger: FleetLedgerStore;
  let attention: FleetAttention;

  const host = (): FleetHost => ({
    tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
    sessions: () => sessions,
    starting: () => [],
    transcript: async (sessionId) => {
      const t = transcripts.get(sessionId);
      if (t === undefined) return null;
      await t.tail.read(t.path);
      return t;
    },
    inputsFor: () => [],
    git: async () => Promise.reject(new Error('unused')),
    now: () => NOW
  });

  const pull = async (): ReturnType<typeof pullDigest> =>
    pullDigest({ host: host(), ledger, attention }, THREAD);

  /** Move sessions to a new state, as the registry would report it. */
  const report = (...next: FleetSession[]): void => {
    for (const s of next) {
      sessions = [...sessions.filter((x) => x.sessionId !== s.sessionId), s];
      attention.observe({ sessionId: s.sessionId, session: s, event: null } as ClaudeSessionChange);
    }
  };

  function withTranscript(sessionId: string, content: string): void {
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, content);
    const t: SessionTranscript = {
      path,
      brief: new BriefBuilder(),
      tail: new TranscriptTail({ onLine: (l) => l.events.forEach((e) => t.brief.apply(e)) })
    };
    transcripts.set(sessionId, t);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-digest-'));
    sessions = [];
    transcripts = new Map();
    ledger = new FleetLedgerStore(dir);
    attention = new FleetAttention();
    report(session(1), session(2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('has nothing to say when nothing needs attention', async () => {
    expect(await pull()).toEqual({ text: null, paused: false });
    expect(ledger.chain(THREAD)).toBe(0);
  });

  it('covers every session that needs attention, with what changed and the ledger entry', async () => {
    withTranscript(
      's1',
      prompt('u1', 'Fix the flaky login test') + reply('a1', 'All 42 tests pass.')
    );
    ledger.addEntry(THREAD, {
      action: 'send',
      ref: 'pane0001',
      paneId: 'pane0001-x',
      sessionId: 's1',
      epoch: 0,
      prompt: '[orchestrator] Run the tests',
      why: 'the refactor is done',
      expect: 'a pass or the failing test names',
      at: NOW - 30_000,
      started: true
    });
    report(
      finished(1),
      session(2, {
        phase: 'waitingForApproval',
        phaseSince: NOW - 500,
        pendingPermissions: [
          {
            sessionId: 's2',
            toolUseId: 't1',
            tool: { toolName: 'Bash', toolInput: { command: 'rm -rf build' } },
            receivedAt: NOW
          }
        ]
      })
    );

    const out = await pull();
    expect(out.paused).toBe(false);
    const [head, ...details] = (out.text ?? '').split('\n\n');
    expect(head).toBe(
      [
        '- pane0001 (work › tab 1) finished its turn and is waiting for a prompt.',
        '- pane0002 (work › tab 2) is waiting for the user to approve Bash.'
      ].join('\n')
    );
    const text = details.join('\n\n');
    expect(text).toContain('pane0001 (work › tab 1):\n<session-data session="pane0001">');
    expect(text).toContain('All 42 tests pass.');
    expect(text).toMatch(/Ledger:\n- #1 prompted pane0001 30s ago · answered/);
    expect(text).toContain(
      '<session-data session="pane0002">\nWaiting for the user to allow or deny: Bash: rm -rf build\n</session-data>'
    );
    expect(ledger.chain(THREAD)).toBe(1);

    // Taken: the same changes do not come round again, and the read cursor moved.
    expect(await pull()).toEqual({ text: null, paused: false });
    report(session(1, { phaseSince: NOW - 100 }), finished(1, { phaseSince: NOW - 50 }));
    expect((await pull()).text).toContain('Nothing changed since the last read.');
  });

  it('skips a session that has moved on, and one a wait is covering', async () => {
    report(finished(1));
    // The user prompted it again before the digest was taken.
    report(session(1, { phaseSince: NOW - 10 }));
    const release = attention.hold(THREAD, new Set(['pane0002-x']));
    report(finished(2));
    expect(await pull()).toEqual({ text: null, paused: false });
    release();
    expect(await pull()).toEqual({ text: null, paused: false });
  });

  it('reports an ending even after the session has left', async () => {
    report(session(1, { phase: 'ended', phaseSince: NOW - 10 }));
    sessions = sessions.filter((s) => s.sessionId !== 's1');
    attention.observe({ sessionId: 's1', session: null, event: null });
    const out = await pull();
    expect(out.text).toContain('- pane0001 ended.');
  });

  it('describes six sessions and counts the rest', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => i + 1);
    report(...eight.map((n) => session(n)));
    report(...eight.map((n) => finished(n)));
    const head = (await pull()).text?.split('\n\n')[0].split('\n') ?? [];
    expect(head).toHaveLength(7);
    expect(head[6]).toBe('- 2 more sessions need attention; call fleet_sessions.');
  });

  it('keeps each session to about 1,200 characters', async () => {
    withTranscript(
      's1',
      prompt('u1', `Write the report ${'goal '.repeat(200)}`) +
        reply('a1', 'started') +
        prompt('u2', `Now the summary ${'ask '.repeat(200)}`) +
        reply('a2', 'word '.repeat(2_000))
    );
    report(finished(1));
    const detail = (await pull()).text?.split('\n\n').slice(1).join('\n\n') ?? '';
    expect(detail.length).toBeLessThan(1_400);
    expect(detail).toContain('[cut to fit');
  });

  it(`pauses at ${FLEET_CHAIN_LIMIT} in a row, holds what comes next, and resumes when the user writes`, async () => {
    for (let i = 1; i < FLEET_CHAIN_LIMIT; i++) {
      report(
        session(1, { phaseSince: NOW + i * 10 }),
        finished(1, { phaseSince: NOW + i * 10 + 1 })
      );
      expect(await pull()).toMatchObject({ paused: false });
    }
    expect(chainRefusal(ledger, THREAD)).toBeNull();

    report(session(1, { phaseSince: NOW + 100 }), finished(1, { phaseSince: NOW + 101 }));
    const last = await pull();
    expect(last.paused).toBe(true);
    expect(last.text).toContain('sends and spawns are paused');
    expect(chainRefusal(ledger, THREAD)).toContain('paused until they write');

    report(session(2, { phaseSince: NOW + 200 }), finished(2, { phaseSince: NOW + 201 }));
    expect(await pull()).toEqual({ text: null, paused: true });
    // Survives a restart of Fleet.
    expect(new FleetLedgerStore(dir).chain(THREAD)).toBe(FLEET_CHAIN_LIMIT);

    ledger.resetChain(THREAD);
    const held = await pull();
    expect(held.paused).toBe(false);
    expect(held.text).toContain('- pane0002 (work › tab 2) finished its turn');
  });
});
