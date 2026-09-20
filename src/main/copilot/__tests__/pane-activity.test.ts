import { describe, it, expect, vi } from 'vitest';
import { CopilotPaneActivity, phaseToActivityState } from '../pane-activity';
import type { CopilotSession, CopilotSessionPhase } from '../../../shared/types';

function session(overrides: Partial<CopilotSession> = {}): CopilotSession {
  return {
    sessionId: 'session-1',
    cwd: '/repo',
    projectName: 'repo',
    phase: 'processing',
    pid: 4242,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0,
    ...overrides
  };
}

describe('phaseToActivityState', () => {
  const cases: Array<[CopilotSessionPhase, string | null]> = [
    ['processing', 'working'],
    ['compacting', 'working'],
    ['waitingForApproval', 'needs_me'],
    ['waitingForInput', 'needs_me'],
    ['idle', 'idle'],
    ['ended', null]
  ];

  for (const [phase, expected] of cases) {
    it(`maps ${phase} to ${expected}`, () => {
      expect(phaseToActivityState(phase)).toBe(expected);
    });
  }
});

describe('CopilotPaneActivity', () => {
  function setup(findPane: (pid: number) => string | null = () => 'pane-1') {
    const setHookState = vi.fn();
    const findPaneForPid = vi.fn(findPane);
    return {
      setHookState,
      findPaneForPid,
      bridge: new CopilotPaneActivity(setHookState, findPaneForPid)
    };
  }

  it('pushes the session phase onto its pane', () => {
    const { bridge, setHookState } = setup();

    bridge.sync([session({ phase: 'waitingForApproval' })]);

    expect(setHookState).toHaveBeenCalledWith('pane-1', 'needs_me');
  });

  it('releases the pane when the session goes away', () => {
    const { bridge, setHookState } = setup();
    bridge.sync([session()]);
    setHookState.mockClear();

    bridge.sync([]);

    expect(setHookState).toHaveBeenCalledWith('pane-1', null);
  });

  it('resolves a pane once however many hook events arrive', () => {
    const { bridge, findPaneForPid } = setup();

    bridge.sync([session({ phase: 'processing' })]);
    bridge.sync([session({ phase: 'waitingForApproval' })]);
    bridge.sync([session({ phase: 'idle' })]);

    expect(findPaneForPid).toHaveBeenCalledTimes(1);
  });

  it('caches a miss so a session outside Fleet stops costing a process walk', () => {
    const { bridge, findPaneForPid, setHookState } = setup(() => null);

    bridge.sync([session()]);
    bridge.sync([session()]);

    expect(findPaneForPid).toHaveBeenCalledTimes(1);
    expect(setHookState).not.toHaveBeenCalled();
  });

  it('retries a session that has no PID yet', () => {
    const { bridge, findPaneForPid, setHookState } = setup();

    bridge.sync([session({ pid: undefined })]);
    expect(findPaneForPid).not.toHaveBeenCalled();
    expect(setHookState).not.toHaveBeenCalled();

    bridge.sync([session({ pid: 4242 })]);
    expect(setHookState).toHaveBeenCalledWith('pane-1', 'working');
  });

  it('keeps sessions on separate panes apart', () => {
    const { setHookState } = setup();
    const bridge = new CopilotPaneActivity(setHookState, (pid) =>
      pid === 1 ? 'pane-1' : 'pane-2'
    );

    bridge.sync([
      session({ sessionId: 'a', pid: 1, phase: 'processing' }),
      session({ sessionId: 'b', pid: 2, phase: 'waitingForApproval' })
    ]);

    expect(setHookState).toHaveBeenCalledWith('pane-1', 'working');
    expect(setHookState).toHaveBeenCalledWith('pane-2', 'needs_me');
  });

  it('releases every pane on clear', () => {
    const { bridge, setHookState } = setup();
    bridge.sync([session()]);
    setHookState.mockClear();

    bridge.clear();

    expect(setHookState).toHaveBeenCalledWith('pane-1', null);
  });
});
