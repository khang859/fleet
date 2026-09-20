import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityTracker } from '../activity-tracker';
import { CopilotPaneActivity } from '../copilot/pane-activity';
import { EventBus } from '../event-bus';
import type { CopilotSession } from '../../shared/types';

const AGENT_PID = 4242;

function session(phase: CopilotSession['phase']): CopilotSession {
  return {
    sessionId: 'session-1',
    cwd: '/repo',
    projectName: 'repo',
    phase,
    pid: AGENT_PID,
    pendingPermissions: [],
    lastActivity: 0,
    createdAt: 0
  };
}

/**
 * The bridge and the tracker each release a pane on their own trigger - one on
 * a hook event, one on the poll - so the behaviour that matters only shows up
 * with both wired together.
 */
describe('hook state across the bridge and the tracker', () => {
  let agentAlive: boolean;
  let tracker: ActivityTracker;
  let bridge: CopilotPaneActivity;

  beforeEach(() => {
    vi.useFakeTimers();
    agentAlive = true;
    tracker = new ActivityTracker(new EventBus(), {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 2000,
      getProcessName: () => 'zsh',
      isProcessAlive: () => agentAlive
    });
    bridge = new CopilotPaneActivity(
      (paneId, state, pid) => tracker.setHookState(paneId, state, pid),
      () => 'pane-1',
      () => agentAlive
    );
    tracker.trackPane('pane-1');
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('recovers a pane whose agent quit without a closing hook', () => {
    bridge.sync([session('waitingForApproval')]);
    expect(tracker.getState('pane-1')).toBe('needs_me');

    agentAlive = false;
    vi.advanceTimersByTime(2000);

    expect(tracker.getState('pane-1')).toBe('idle');
    expect(tracker.getCounts().needsMe).toBe(0);
  });

  it('does not let a dead session take the pane again on a later sync', () => {
    // sync runs over every session, so a hook event from any other agent would
    // otherwise re-assert the dead one's state onto the pane it had claimed.
    bridge.sync([session('waitingForApproval')]);
    agentAlive = false;
    vi.advanceTimersByTime(2000);

    bridge.sync([session('waitingForApproval')]);

    expect(tracker.getState('pane-1')).toBe('idle');
    expect(tracker.getCounts().needsMe).toBe(0);
  });
});
