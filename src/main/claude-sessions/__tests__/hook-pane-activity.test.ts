import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityTracker } from '../../activity-tracker';
import { EventBus } from '../../event-bus';
import { PaneActivityBridge } from '../pane-activity-bridge';
import { ClaudeSessionRegistry } from '../registry';
import type { HookEvent } from '../hook-events';

const AGENT_PID = 4242;

const hook = (overrides: Partial<HookEvent>): HookEvent => ({
  sessionId: 'session-1',
  cwd: '/repo',
  event: 'PermissionRequest',
  status: 'waiting_for_approval',
  tool: 'Bash',
  toolUseId: 'tu-1',
  pid: AGENT_PID,
  protocol: 2,
  ...overrides
});

/**
 * The registry, the bridge and the tracker each release a pane on their own
 * trigger - an end event, a liveness sweep, a process poll - so the behaviour
 * that matters only shows up with all three wired together.
 */
describe('hook state across the registry, the bridge and the tracker', () => {
  let agentAlive: boolean;
  let tracker: ActivityTracker;
  let registry: ClaudeSessionRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    agentAlive = true;
    tracker = new ActivityTracker(new EventBus(), {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 2000,
      getProcessName: () => 'zsh',
      isProcessAlive: () => agentAlive
    });
    registry = new ClaudeSessionRegistry({ isAlive: () => agentAlive });
    const bridge = new PaneActivityBridge((paneId, state, pid) =>
      tracker.setHookState(paneId, state, pid)
    );
    registry.subscribe((change) => bridge.apply(change));
    tracker.trackPane('pane-1');
    tracker.trackPane('pane-2');
  });

  afterEach(() => {
    registry.dispose();
    tracker.dispose();
    vi.useRealTimers();
  });

  it('recovers a pane whose agent quit without a closing hook', () => {
    registry.ingest(hook({}), { paneId: 'pane-1' });
    expect(tracker.getState('pane-1')).toBe('needs_me');

    agentAlive = false;
    vi.advanceTimersByTime(2000);

    expect(tracker.getState('pane-1')).toBe('idle');
    expect(tracker.getCounts().needsMe).toBe(0);
  });

  it('does not let a dead session take the pane again when another agent reports', () => {
    registry.ingest(hook({}), { paneId: 'pane-1' });
    agentAlive = false;
    vi.advanceTimersByTime(2000);
    registry.pruneDead();

    agentAlive = true;
    registry.ingest(hook({ sessionId: 'session-2', pid: 777 }), { paneId: 'pane-2' });

    expect(tracker.getState('pane-1')).toBe('idle');
    expect(tracker.getState('pane-2')).toBe('needs_me');
    expect(tracker.getCounts().needsMe).toBe(1);
  });

  it('follows the session through a finished turn', () => {
    registry.ingest(hook({ event: 'UserPromptSubmit', status: 'processing' }), {
      paneId: 'pane-1'
    });
    expect(tracker.getState('pane-1')).toBe('working');
    registry.ingest(hook({ event: 'Stop', status: 'waiting_for_input' }), { paneId: 'pane-1' });
    expect(tracker.getState('pane-1')).toBe('idle');
    expect(tracker.getCounts().needsMe).toBe(0);
  });

  it('asks for the user when the agent shows a question dialog', () => {
    registry.ingest(hook({ tool: 'AskUserQuestion' }), { paneId: 'pane-1' });
    expect(tracker.getState('pane-1')).toBe('needs_me');
  });
});
