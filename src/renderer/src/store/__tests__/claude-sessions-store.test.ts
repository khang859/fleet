import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  contextPercent,
  formatCost,
  formatPhaseAge,
  initClaudeSessionsListener,
  sessionUrgency,
  sortSessions,
  useClaudeSessionsStore
} from '../claude-sessions-store';
import type { ClaudeSessionView, ClaudeSessionsSnapshot } from '../../../../shared/claude-sessions';

function session(over: Partial<ClaudeSessionView> = {}): ClaudeSessionView {
  return {
    sessionId: 's',
    paneId: 'p',
    epoch: 0,
    cwd: '/repo',
    projectName: 'repo',
    phase: 'processing',
    waitingKind: null,
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

function snapshot(sessions: ClaudeSessionView[]): ClaudeSessionsSnapshot {
  return { status: { state: 'running' }, installProblems: [], sessions };
}

afterEach(() => {
  vi.unstubAllGlobals();
  useClaudeSessionsStore.setState({ snapshot: null });
});

describe('sessionUrgency', () => {
  it('needs the user for a permission or a question, not for a prompt', () => {
    expect(sessionUrgency(session({ phase: 'waitingForApproval' }))).toBe('needsYou');
    expect(sessionUrgency(session({ phase: 'waitingForInput', waitingKind: 'question' }))).toBe(
      'needsYou'
    );
    expect(sessionUrgency(session({ phase: 'waitingForInput', waitingKind: 'prompt' }))).toBe(
      'ready'
    );
  });

  it('counts compacting as working and a fresh session as idle', () => {
    expect(sessionUrgency(session({ phase: 'processing' }))).toBe('working');
    expect(sessionUrgency(session({ phase: 'compacting' }))).toBe('working');
    expect(sessionUrgency(session({ phase: 'starting' }))).toBe('idle');
  });
});

describe('sortSessions', () => {
  it('puts sessions needing the user first, the longest-waiting first', () => {
    const sorted = sortSessions([
      session({ sessionId: 'ready', phase: 'waitingForInput', waitingKind: 'prompt' }),
      session({ sessionId: 'working', phase: 'processing', phaseSince: 1 }),
      session({ sessionId: 'new-ask', phase: 'waitingForApproval', phaseSince: 20 }),
      session({ sessionId: 'old-ask', phase: 'waitingForApproval', phaseSince: 10 }),
      session({ sessionId: 'idle', phase: 'starting', phaseSince: 5 })
    ]);
    expect(sorted.map((s) => s.sessionId)).toEqual([
      'old-ask',
      'new-ask',
      'working',
      'ready',
      'idle'
    ]);
  });

  it('breaks a tie by session id and leaves its input alone', () => {
    const input = [session({ sessionId: 'b' }), session({ sessionId: 'a' })];
    expect(sortSessions(input).map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(input.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });
});

describe('formatters', () => {
  it('formats a phase age in its largest whole unit', () => {
    expect(formatPhaseAge(-5)).toBe('0s');
    expect(formatPhaseAge(59_999)).toBe('59s');
    expect(formatPhaseAge(60_000)).toBe('1m');
    expect(formatPhaseAge(3 * 3_600_000)).toBe('3h');
    expect(formatPhaseAge(50 * 3_600_000)).toBe('2d');
  });

  it('formats a cost to the cent, showing a tiny one as under a cent', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(12.345)).toBe('$12.35');
  });

  it('gives context use as a capped percentage, or null when unknown', () => {
    const usage = (contextTokens: number | null, contextLimit: number | null) =>
      session({ usage: { costUsd: null, contextTokens, contextLimit } });
    expect(contextPercent(usage(50_000, 200_000))).toBe(25);
    expect(contextPercent(usage(250_000, 200_000))).toBe(100);
    expect(contextPercent(usage(null, 200_000))).toBeNull();
    expect(contextPercent(usage(1000, null))).toBeNull();
  });
});

describe('initClaudeSessionsListener', () => {
  function stubBridge() {
    let push: ((s: ClaudeSessionsSnapshot) => void) | undefined;
    let answer: ((s: ClaudeSessionsSnapshot) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal('window', {
      fleet: {
        claudeSessions: {
          onChanged: (cb: (s: ClaudeSessionsSnapshot) => void) => {
            push = cb;
            return unsubscribe;
          },
          list: async () =>
            new Promise<ClaudeSessionsSnapshot>((resolve) => {
              answer = resolve;
            })
        }
      }
    });
    return {
      push: (s: ClaudeSessionsSnapshot) => push?.(s),
      answer: (s: ClaudeSessionsSnapshot) => answer?.(s),
      unsubscribe
    };
  }

  it('fills the store from the first list', async () => {
    const bridge = stubBridge();
    initClaudeSessionsListener();
    const listed = snapshot([session({ sessionId: 'listed' })]);
    bridge.answer(listed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useClaudeSessionsStore.getState().snapshot).toBe(listed);
  });

  it('keeps a pushed snapshot over a list answer that arrives after it', async () => {
    const bridge = stubBridge();
    const stop = initClaudeSessionsListener();
    const pushed = snapshot([session({ sessionId: 'pushed' })]);
    bridge.push(pushed);
    bridge.answer(snapshot([]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useClaudeSessionsStore.getState().snapshot).toBe(pushed);
    stop();
    expect(bridge.unsubscribe).toHaveBeenCalled();
  });
});
