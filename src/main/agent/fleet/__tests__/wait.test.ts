import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionChange } from '../../../../shared/claude-sessions';
import type { FleetWaitArgs } from '../../../../shared/fleet-tools';
import type { FleetHost, FleetSession, FleetStarting } from '../host';
import { FleetAttention } from '../attention';
import { waitForSessions } from '../wait';

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const AT = 1_000_000;

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: 's1',
    paneId: 'abcdef12-pane',
    ref: 'abcdef12',
    label: 'fleet › api',
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'processing',
    waitingKind: null,
    phaseSince: AT - 60_000,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: AT,
    createdAt: 0,
    usage: { costUsd: null, contextTokens: null, contextLimit: null },
    git: null,
    ...over
  };
}

const other = (over: Partial<FleetSession> = {}): FleetSession =>
  session({
    sessionId: 's2',
    paneId: '99887766-pane',
    ref: '99887766',
    label: 'fleet › web',
    ...over
  });

describe('fleet_wait', () => {
  let sessions: FleetSession[];
  let starting: FleetStarting[];
  let listeners: Set<(change: ClaudeSessionChange) => void>;
  let waits: FleetAttention;
  let briefs: string[];

  const host = (): FleetHost => ({
    tracking: () => ({ status: { state: 'running' }, installProblems: [] }),
    sessions: () => sessions,
    starting: () => starting,
    transcript: async () => Promise.resolve(null),
    inputsFor: () => [],
    git: async () => Promise.reject(new Error('unused')),
    now: () => AT
  });

  /** Put a session in the registry and tell the listeners, as a hook event would. */
  const report = (next: FleetSession, hook?: string): void => {
    sessions = [...sessions.filter((s) => s.sessionId !== next.sessionId), next];
    const event =
      hook === undefined
        ? null
        : { seq: 1, sessionId: next.sessionId, at: AT, event: hook, status: '', phase: next.phase };
    for (const l of listeners) l({ sessionId: next.sessionId, session: next, event });
  };
  const remove = (sessionId: string): void => {
    sessions = sessions.filter((s) => s.sessionId !== sessionId);
    for (const l of listeners) l({ sessionId, session: null, event: null });
  };

  const wait = async (
    args: FleetWaitArgs,
    signal = new AbortController().signal
  ): Promise<{ text: string; summary: string }> =>
    waitForSessions(
      {
        host: host(),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        attention: waits,
        brief: async (ref) => {
          briefs.push(ref);
          return Promise.resolve(`<session-data ref="${ref}">tests pass</session-data>`);
        }
      },
      THREAD,
      args,
      signal
    );

  beforeEach(() => {
    vi.useFakeTimers();
    sessions = [session()];
    starting = [];
    listeners = new Set();
    waits = new FleetAttention();
    briefs = [];
  });
  afterEach(() => vi.useRealTimers());

  it('returns at once when no watched session is working, and says so', async () => {
    sessions = [session({ phase: 'waitingForInput', waitingKind: 'prompt' })];
    const out = await wait({ timeout_s: 60 });
    expect(out.summary).toBe('nothing working');
    expect(out.text).toContain('None of the watched sessions is working');
    expect(out.text).toContain('abcdef12 · fleet › api · waiting for a prompt for 1m');
    expect(listeners.size).toBe(0);

    sessions = [];
    expect((await wait({ timeout_s: 60 })).text).toContain('no sessions to wait for');
  });

  it('lists at most six other sessions, fenced', async () => {
    sessions = Array.from({ length: 8 }, (_, i) =>
      other({
        sessionId: `s${i}`,
        paneId: `0000000${i}-pane`,
        ref: `0000000${i}`,
        phase: 'waitingForInput',
        waitingKind: 'prompt'
      })
    );
    const lines = (await wait({ timeout_s: 60 })).text.split('\n');
    expect(lines[1]).toBe('<session-data session="all">');
    expect(lines.filter((l) => l.includes('· fleet › web ·'))).toHaveLength(6);
    expect(lines.at(-2)).toBe('- and 2 more; fleet_sessions lists them all');
    expect(lines.at(-1)).toBe('</session-data>');
  });

  it('only looks at the sessions it was asked about', async () => {
    sessions = [session({ phase: 'waitingForInput', waitingKind: 'prompt' }), other()];
    expect((await wait({ sessions: ['abcdef12'], timeout_s: 60 })).summary).toBe('nothing working');
    await expect(wait({ sessions: ['nope'], timeout_s: 60 })).rejects.toThrow(
      'No session has the ref "nope"'
    );
  });

  it('returns with what changed when a watched session finishes its turn', async () => {
    sessions = [session(), other()];
    const pending = wait({ timeout_s: 60 });
    expect(waits.covers(THREAD, 'abcdef12-pane')).toBe(true);
    // Noise first: another event in the same phase, and a session outside the wait is irrelevant here.
    report(session({ lastActivity: AT + 1 }));
    report(session({ phase: 'waitingForInput', waitingKind: 'prompt', phaseSince: AT + 2_000 }));
    const out = await pending;
    expect(out.summary).toBe('abcdef12 needs attention');
    // Labels are session data, so they stay inside the fence.
    expect(out.text).toMatch(/^abcdef12 finished its turn and is waiting for a prompt\.\n/);
    expect(out.text).toContain('What changed:\n<session-data ref="abcdef12">tests pass');
    expect(out.text).toContain(
      'Other watched sessions:\n<session-data session="all">\n- 99887766 · fleet › web · working for 1m\n</session-data>'
    );
    expect(briefs).toEqual(['abcdef12']);
    expect(listeners.size).toBe(0);
    expect(waits.covers(THREAD, 'abcdef12-pane')).toBe(false);
  });

  it('counts a permission request and a question, but not an unwatched session', async () => {
    sessions = [session(), other()];
    const pending = wait({ sessions: ['abcdef12'], timeout_s: 60 });
    expect(waits.covers(THREAD, '99887766-pane')).toBe(false);
    report(other({ phase: 'waitingForInput', waitingKind: 'prompt', phaseSince: AT + 1 }));
    report(
      session({
        phase: 'waitingForApproval',
        phaseSince: AT + 2,
        pendingPermissions: [
          {
            sessionId: 's1',
            toolUseId: 't1',
            tool: { toolName: 'Bash', toolInput: {} },
            receivedAt: AT + 2
          }
        ]
      })
    );
    expect((await pending).text).toContain('is waiting for the user to approve Bash.');

    sessions = [session()];
    const asking = wait({ timeout_s: 60 });
    report(session({ phase: 'waitingForInput', waitingKind: 'question', phaseSince: AT + 3 }));
    expect((await asking).text).toContain('is showing the user a question.');
  });

  it('reports a session whose pane went away, but not one replaced by /clear', async () => {
    const pending = wait({ timeout_s: 60 });
    // `/clear`: the new session is at its prompt before the old one leaves,
    // which has finished nothing.
    report(
      session({
        sessionId: 's1b',
        epoch: 1,
        phase: 'waitingForInput',
        waitingKind: 'prompt',
        phaseSince: AT + 1
      }),
      'SessionStart'
    );
    remove('s1');
    remove('s1b');
    const out = await pending;
    expect(out.text).toContain('abcdef12 ended; its pane is gone.');
    expect(out.summary).toBe('abcdef12 ended');
    expect(briefs).toEqual([]);
  });

  it('waits on a spawned pane until its session reports and finishes', async () => {
    sessions = [];
    starting = [{ ref: 'feedface', paneId: 'feedface-pane', label: 'wt', cwd: '/w', at: AT }];
    const pending = wait({ sessions: ['feedface'], timeout_s: 60 });
    starting = [];
    const spawned = session({ sessionId: 'new', paneId: 'feedface-pane', ref: 'feedface' });
    report(spawned);
    report({ ...spawned, phase: 'waitingForInput', waitingKind: 'prompt', phaseSince: AT + 5 });
    expect((await pending).summary).toBe('feedface needs attention');
  });

  it('times out with where the sessions are now', async () => {
    const pending = wait({ timeout_s: 30 });
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await pending;
    expect(out.summary).toBe('timed out after 30s');
    expect(out.text).toContain('No watched session needed attention within 30s.');
    expect(out.text).toContain('- abcdef12 · fleet › api · working for 1m');
    expect(listeners.size).toBe(0);
    expect(waits.covers(THREAD, 'abcdef12-pane')).toBe(false);
  });

  it('stops when the user stops the turn', async () => {
    const controller = new AbortController();
    const pending = wait({ timeout_s: 600 }, controller.signal);
    expect(waits.covers(THREAD, 'anything')).toBe(true);
    controller.abort();
    expect(await pending).toEqual({ text: 'The user stopped the wait.', summary: 'stopped' });
    expect(listeners.size).toBe(0);
    expect(waits.covers(THREAD, 'anything')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
