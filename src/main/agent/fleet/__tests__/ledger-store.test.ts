import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSession, ClaudeSessionChange } from '../../../../shared/claude-sessions';
import { FleetLedgerStore, type FleetCursor, type NewLedgerEntry } from '../ledger-store';

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const cursor = (rev: number): FleetCursor => ({ sessionId: 's', epoch: 0, rev, turn: 1 });

describe('FleetLedgerStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps cursors across a restart, next to the session log', () => {
    new FleetLedgerStore(dir).setCursor(THREAD, 'abcdef12', cursor(4));
    expect(readdirSync(dir)).toEqual([`${THREAD}.fleet.json`]);
    expect(new FleetLedgerStore(dir).cursor(THREAD, 'abcdef12')).toEqual(cursor(4));
  });

  it('starts over from a damaged file rather than failing', () => {
    writeFileSync(join(dir, `${THREAD}.fleet.json`), '{not json');
    const store = new FleetLedgerStore(dir);
    expect(store.cursor(THREAD, 'abcdef12')).toBeNull();
    store.setCursor(THREAD, 'abcdef12', cursor(1));
    expect(new FleetLedgerStore(dir).cursor(THREAD, 'abcdef12')).toEqual(cursor(1));
  });

  it('writes nothing for an id that is not a uuid', () => {
    const store = new FleetLedgerStore(dir);
    store.setCursor('../../escape', 'abcdef12', cursor(2));
    expect(store.cursor('../../escape', 'abcdef12')).toEqual(cursor(2));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is deleted with the session', () => {
    const store = new FleetLedgerStore(dir);
    store.setCursor(THREAD, 'abcdef12', cursor(3));
    store.delete(THREAD);
    expect(existsSync(join(dir, `${THREAD}.fleet.json`))).toBe(false);
    expect(store.cursor(THREAD, 'abcdef12')).toBeNull();
  });

  it('keeps the most recently read sessions when it is full', () => {
    const store = new FleetLedgerStore(dir);
    for (let i = 0; i < 105; i++) store.setCursor(THREAD, `ref-${i}`, cursor(i));
    expect(store.cursor(THREAD, 'ref-4')).toBeNull();
    // Read again, so it is the newest and ref-6 is next to go.
    store.setCursor(THREAD, 'ref-5', cursor(99));
    store.setCursor(THREAD, 'ref-105', cursor(105));
    const reloaded = new FleetLedgerStore(dir);
    expect(reloaded.cursor(THREAD, 'ref-6')).toBeNull();
    expect(reloaded.cursor(THREAD, 'ref-5')).toEqual(cursor(99));
    expect(reloaded.cursor(THREAD, 'ref-105')).toEqual(cursor(105));
  });
});

const AT = 1_000_000;

function claude(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    paneId: 'pane-1-aaaa',
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'waitingForInput',
    waitingKind: 'prompt',
    phaseSince: AT - 60_000,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: AT,
    createdAt: 0,
    ...over
  };
}

const change = (session: ClaudeSession | null, sessionId = 's1'): ClaudeSessionChange => ({
  sessionId,
  session,
  event: null
});

function send(over: Partial<NewLedgerEntry> = {}): NewLedgerEntry {
  return {
    action: 'send',
    ref: 'pane-1-a',
    paneId: 'pane-1-aaaa',
    sessionId: 's1',
    epoch: 0,
    prompt: '[orchestrator] Run the tests',
    why: 'the refactor is done',
    expect: 'a pass or the failing test names',
    at: AT,
    started: true,
    ...over
  };
}

describe('FleetLedgerStore entries', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('numbers entries, keeps the start of a long prompt, and survives a restart', () => {
    const store = new FleetLedgerStore(dir);
    expect(store.addEntry(THREAD, send()).id).toBe('#1');
    const long = store.addEntry(THREAD, send({ prompt: 'x'.repeat(500) }));
    expect(long.id).toBe('#2');
    expect(long.prompt).toBe(`${'x'.repeat(200)}…`);
    const reloaded = new FleetLedgerStore(dir);
    expect(reloaded.entries(THREAD).map((e) => [e.id, e.state])).toEqual([
      ['#1', 'open'],
      ['#2', 'open']
    ]);
    expect(reloaded.addEntry(THREAD, send()).id).toBe('#3');
  });

  it('is answered once the session waits for a prompt again after it was sent', () => {
    const store = new FleetLedgerStore(dir);
    store.addEntry(THREAD, send());
    // The registry has not caught up with the submit yet: still the wait from before.
    store.observe(change(claude()), AT + 10);
    expect(store.entries(THREAD)[0].state).toBe('open');
    store.observe(change(claude({ phase: 'processing', waitingKind: null, phaseSince: AT + 20 })));
    expect(store.entries(THREAD)[0].state).toBe('open');
    // A question is part of the turn, not its answer.
    store.observe(change(claude({ waitingKind: 'question', phaseSince: AT + 30 })));
    expect(store.entries(THREAD)[0].state).toBe('open');
    store.observe(change(claude({ phaseSince: AT + 40 })));
    expect(store.entries(THREAD)[0]).toMatchObject({ state: 'answered', settledAt: AT + 40 });
    expect(new FleetLedgerStore(dir).entries(THREAD)[0].state).toBe('answered');
  });

  it('waits to see work start on a send Claude Code did not acknowledge', () => {
    const store = new FleetLedgerStore(dir);
    store.addEntry(THREAD, send({ started: false }));
    store.observe(change(claude({ phaseSince: AT + 10 })));
    expect(store.entries(THREAD)[0].state).toBe('open');
    store.observe(change(claude({ phase: 'processing', waitingKind: null, phaseSince: AT + 20 })));
    store.observe(change(claude({ phaseSince: AT + 30 })));
    expect(store.entries(THREAD)[0].state).toBe('answered');
  });

  it('ends when the session goes away or is cleared before answering', () => {
    const store = new FleetLedgerStore(dir);
    store.addEntry(THREAD, send());
    store.addEntry(THREAD, send({ sessionId: 's2', paneId: 'pane-2-bbbb' }));
    store.observe(change(null), AT + 5);
    store.observe(
      change(claude({ sessionId: 's2', paneId: 'pane-2-bbbb', epoch: 1 }), 's2'),
      AT + 6
    );
    expect(store.entries(THREAD).map((e) => [e.state, e.settledAt])).toEqual([
      ['ended', AT + 5],
      ['ended', AT + 6]
    ]);
  });

  it('ignores changes to other sessions', () => {
    const store = new FleetLedgerStore(dir);
    store.addEntry(THREAD, send());
    store.observe(change(null, 's9'));
    expect(store.entries(THREAD)[0].state).toBe('open');
  });

  it('adopts the session a spawned tab reports, and ends one whose pane is gone before it did', () => {
    const store = new FleetLedgerStore(dir);
    store.addEntry(THREAD, send({ action: 'spawn', sessionId: null, epoch: null, started: false }));
    // Held at the trust dialog for as long as the user leaves it there.
    store.reconcile(THREAD, [], new Set(['pane-1-aaaa']), AT + 3_600_000);
    expect(store.entries(THREAD)[0]).toMatchObject({ state: 'open', sessionId: null });
    store.observe(
      change(
        claude({ sessionId: 'new', phase: 'processing', waitingKind: null, phaseSince: AT + 1 }),
        'new'
      )
    );
    expect(store.entries(THREAD)[0]).toMatchObject({ sessionId: 'new', epoch: 0, started: true });
    store.observe(change(claude({ sessionId: 'new', phaseSince: AT + 2 }), 'new'));
    expect(store.entries(THREAD)[0].state).toBe('answered');

    store.addEntry(
      THREAD,
      send({ action: 'spawn', sessionId: null, epoch: null, started: false, paneId: 'p3' })
    );
    store.reconcile(THREAD, [], new Set(), AT + 5);
    expect(store.entries(THREAD)[1]).toMatchObject({ state: 'ended', settledAt: AT + 5 });
  });

  it('settles a conversation that was not loaded when its session answered', () => {
    new FleetLedgerStore(dir).addEntry(THREAD, send());
    // After a restart: nothing loaded, so the change is seen by no entry.
    const store = new FleetLedgerStore(dir);
    store.observe(change(claude({ phaseSince: AT + 40 })));
    store.reconcile(THREAD, [claude({ phaseSince: AT + 40 })], new Set(), AT + 50);
    expect(store.entries(THREAD)[0].state).toBe('answered');
  });

  it('drops settled entries before open ones when it is full', () => {
    const store = new FleetLedgerStore(dir);
    store.addEntry(THREAD, send({ sessionId: 'gone' }));
    store.observe(change(null, 'gone'));
    for (let i = 0; i < 50; i++) store.addEntry(THREAD, send());
    const ids = store.entries(THREAD).map((e) => e.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('#2');
    store.addEntry(THREAD, send());
    // Nothing settled left: the oldest open one goes.
    expect(store.entries(THREAD)[0].id).toBe('#3');
  });

  it('reads a file written before it had entries', () => {
    writeFileSync(join(dir, `${THREAD}.fleet.json`), JSON.stringify({ cursors: {} }));
    const store = new FleetLedgerStore(dir);
    expect(store.entries(THREAD)).toEqual([]);
    expect(store.addEntry(THREAD, send()).id).toBe('#1');
  });
});
