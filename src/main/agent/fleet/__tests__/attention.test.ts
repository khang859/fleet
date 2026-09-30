import { describe, expect, it } from 'vitest';
import type { ClaudeSession, ClaudeSessionChange } from '../../../../shared/claude-sessions';
import { FleetAttention } from '../attention';

const THREAD = 't1';

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    paneId: 'p1',
    epoch: 0,
    cwd: '/work',
    projectName: 'work',
    phase: 'processing',
    waitingKind: null,
    phaseSince: 1,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 1,
    createdAt: 0,
    ...over
  };
}

const change = (s: ClaudeSession): ClaudeSessionChange => ({
  sessionId: s.sessionId,
  session: s,
  event: null
});
const started = (s: ClaudeSession): ClaudeSessionChange => ({
  sessionId: s.sessionId,
  session: s,
  event: {
    seq: 1,
    sessionId: s.sessionId,
    at: 1,
    event: 'SessionStart',
    status: '',
    phase: s.phase
  }
});
const gone = (sessionId: string): ClaudeSessionChange => ({
  sessionId,
  session: null,
  event: null
});
const waiting = (over: Partial<ClaudeSession> = {}): ClaudeSession =>
  session({ phase: 'waitingForInput', waitingKind: 'prompt', phaseSince: 2, ...over });

describe('FleetAttention', () => {
  it('logs a session starting to need attention, once per change', () => {
    const a = new FleetAttention();
    a.observe(change(session()));
    expect(a.pending(THREAD)).toEqual([]);
    a.observe(change(waiting()));
    // Claude Code's idle reminder: another event, the same wait.
    a.observe(change(waiting({ lastActivity: 60 })));
    expect(a.pending(THREAD)).toHaveLength(1);
    a.observe(change(waiting({ waitingKind: 'question', phaseSince: 3 })));
    expect(a.pending(THREAD)).toEqual([
      expect.objectContaining({ paneId: 'p1', session: expect.objectContaining({ phaseSince: 3 }) })
    ]);
  });

  it('does not log a session coming up at its prompt, which has finished nothing', () => {
    const a = new FleetAttention();
    a.observe(started(waiting()));
    a.observe(started(waiting({ sessionId: 's1b', epoch: 1, phaseSince: 3 })));
    expect(a.pending(THREAD)).toEqual([]);
    a.observe(change(session({ sessionId: 's1b', epoch: 1, phaseSince: 4 })));
    a.observe(change(waiting({ sessionId: 's1b', epoch: 1, phaseSince: 5 })));
    expect(a.pending(THREAD)).toHaveLength(1);
  });

  it('logs a pane going away, but not a /clear or the removal of an ended session', () => {
    const a = new FleetAttention();
    a.observe(change(session()));
    a.observe(change(session({ sessionId: 's1b', epoch: 1 })));
    a.observe(gone('s1'));
    expect(a.pending(THREAD)).toEqual([]);

    a.observe(change(session({ sessionId: 's1b', phase: 'ended', phaseSince: 5 })));
    a.observe(gone('s1b'));
    expect(a.pending(THREAD)).toEqual([
      expect.objectContaining({ session: expect.objectContaining({ phase: 'ended' }) })
    ]);

    a.observe(change(session({ sessionId: 's2', paneId: 'p2' })));
    a.observe(gone('s2'));
    expect(a.pending(THREAD).at(-1)).toMatchObject({ paneId: 'p2', session: null });
  });

  it('starts a conversation from now, and moves past what it took', () => {
    const a = new FleetAttention();
    a.observe(change(waiting()));
    a.startAt(THREAD);
    expect(a.pending(THREAD)).toEqual([]);
    a.observe(change(session({ phaseSince: 4 })));
    a.observe(change(waiting({ phaseSince: 5 })));
    expect(a.pending(THREAD)).toHaveLength(1);
    a.advance(THREAD);
    expect(a.pending(THREAD)).toEqual([]);
    // Another conversation keeps its own place.
    expect(a.pending('t2')).toHaveLength(1);
  });

  it('leaves out what a running wait covers, and what a finished one saw', () => {
    const a = new FleetAttention();
    a.observe(change(session()));
    a.observe(change(session({ sessionId: 's2', paneId: 'p2' })));
    const release = a.hold(THREAD, new Set(['p1']));
    expect(a.covers(THREAD, 'p1')).toBe(true);
    expect(a.covers(THREAD, 'p2')).toBe(false);
    a.observe(change(waiting()));
    a.observe(change(waiting({ sessionId: 's2', paneId: 'p2' })));
    expect(a.pending(THREAD).map((i) => i.paneId)).toEqual(['p2']);
    release();
    expect(a.covers(THREAD, 'p1')).toBe(false);
    expect(a.pending(THREAD).map((i) => i.paneId)).toEqual(['p2']);
    // After the wait, p1 is news again.
    a.observe(change(session({ phaseSince: 7 })));
    a.observe(change(waiting({ phaseSince: 8 })));
    expect(a.pending(THREAD).map((i) => i.paneId)).toEqual(['p2', 'p1']);

    const all = a.hold(THREAD, 'all');
    expect(a.covers(THREAD, 'anything')).toBe(true);
    all();
    expect(a.pending(THREAD)).toEqual([]);
  });
});
