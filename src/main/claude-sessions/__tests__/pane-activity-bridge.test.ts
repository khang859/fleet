import { describe, it, expect, vi } from 'vitest';
import { PaneActivityBridge, phaseToActivityState } from '../pane-activity-bridge';
import type { ClaudeSession, ClaudeSessionPhase } from '../../../shared/claude-sessions';

function session(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'session-1',
    paneId: 'pane-1',
    epoch: 1,
    cwd: '/repo',
    projectName: 'repo',
    phase: 'processing',
    waitingKind: null,
    phaseSince: 0,
    pid: 4242,
    transcriptPath: null,
    configDir: null,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0,
    ...overrides
  };
}

const change = (s: ClaudeSession | null, sessionId = s?.sessionId ?? 'session-1') => ({
  sessionId,
  session: s,
  event: null
});

describe('phaseToActivityState', () => {
  it.each<[ClaudeSessionPhase, string | null]>([
    ['processing', 'working'],
    ['compacting', 'working'],
    ['waitingForApproval', 'needs_me'],
    ['waitingForInput', 'needs_me'],
    ['starting', 'idle'],
    ['ended', null]
  ])('maps %s to %s', (phase, expected) => {
    expect(phaseToActivityState(phase)).toBe(expected);
  });
});

describe('PaneActivityBridge', () => {
  function setup() {
    const setHookState = vi.fn();
    return { setHookState, bridge: new PaneActivityBridge(setHookState) };
  }

  it('pushes the session phase onto its pane', () => {
    const { bridge, setHookState } = setup();
    bridge.apply(change(session({ phase: 'waitingForApproval' })));
    expect(setHookState).toHaveBeenCalledWith('pane-1', 'needs_me', 4242);
  });

  it('releases the pane when the session ends or leaves', () => {
    const { bridge, setHookState } = setup();
    bridge.apply(change(session()));
    bridge.apply(change(session({ phase: 'ended' })));
    expect(setHookState).toHaveBeenLastCalledWith('pane-1', null);

    setHookState.mockClear();
    bridge.apply(change(null));
    expect(setHookState).not.toHaveBeenCalled();
  });

  it('keeps the pane for the session that replaced the one that ended', () => {
    const { bridge, setHookState } = setup();
    bridge.apply(change(session({ sessionId: 'old' })));
    bridge.apply(change(session({ sessionId: 'new', phase: 'waitingForInput' })));
    setHookState.mockClear();

    bridge.apply(change(session({ sessionId: 'old', phase: 'ended' })));

    expect(setHookState).not.toHaveBeenCalled();
  });

  it('follows a session that moved to another pane', () => {
    const { bridge, setHookState } = setup();
    bridge.apply(change(session()));
    bridge.apply(change(session({ paneId: 'pane-2' })));
    expect(setHookState).toHaveBeenCalledWith('pane-1', null);
    expect(setHookState).toHaveBeenLastCalledWith('pane-2', 'working', 4242);
  });

  it('releases every pane on clear', () => {
    const { bridge, setHookState } = setup();
    bridge.apply(change(session()));
    bridge.apply(change(session({ sessionId: 'b', paneId: 'pane-2' })));
    setHookState.mockClear();
    bridge.clear();
    expect(setHookState.mock.calls).toEqual([
      ['pane-1', null],
      ['pane-2', null]
    ]);
  });
});
