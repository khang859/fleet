import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CopilotSessionStore, type HookEvent } from '../copilot/session-store';

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    session_id: 'sess-1',
    cwd: '/tmp/project',
    event: 'UserPromptSubmit',
    status: 'processing',
    pid: 12345,
    ...overrides,
  };
}

describe('CopilotSessionStore', () => {
  let store: CopilotSessionStore;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new CopilotSessionStore();
    onChange = vi.fn();
    store.setOnChange(onChange);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a session on first event', () => {
    store.processHookEvent(makeEvent());
    const sessions = store.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-1');
    expect(sessions[0].phase).toBe('processing');
  });

  it('maps Stop event to waitingForInput phase', () => {
    // Session starts processing
    store.processHookEvent(makeEvent({ status: 'processing' }));
    expect(store.getSessions()[0].phase).toBe('processing');

    // User interrupts — Stop hook fires
    store.processHookEvent(makeEvent({ event: 'Stop', status: 'waiting_for_input' }));
    expect(store.getSessions()[0].phase).toBe('waitingForInput');
  });

  it('maps SubagentStop event to waitingForInput phase', () => {
    store.processHookEvent(makeEvent({ status: 'processing' }));
    store.processHookEvent(makeEvent({ event: 'SubagentStop', status: 'waiting_for_input' }));
    expect(store.getSessions()[0].phase).toBe('waitingForInput');
  });

  it('maps SessionEnd to ended phase and removes session after timeout', () => {
    store.processHookEvent(makeEvent({ status: 'processing' }));
    store.processHookEvent(makeEvent({ event: 'SessionEnd', status: 'ended' }));

    // Session should be filtered out of getSessions immediately (phase === 'ended')
    expect(store.getSessions()).toHaveLength(0);

    // But getSession still returns it
    expect(store.getSession('sess-1')).toBeDefined();
    expect(store.getSession('sess-1')!.phase).toBe('ended');

    // After 30s the session is fully removed
    vi.advanceTimersByTime(30_000);
    expect(store.getSession('sess-1')).toBeUndefined();
  });

  it('transitions processing → waitingForInput → processing correctly', () => {
    store.processHookEvent(makeEvent({ status: 'processing' }));
    expect(store.getSessions()[0].phase).toBe('processing');

    // Interrupt
    store.processHookEvent(makeEvent({ event: 'Stop', status: 'waiting_for_input' }));
    expect(store.getSessions()[0].phase).toBe('waitingForInput');

    // User sends new prompt
    store.processHookEvent(makeEvent({ event: 'UserPromptSubmit', status: 'processing' }));
    expect(store.getSessions()[0].phase).toBe('processing');
  });

  it('handles running_tool status as processing phase', () => {
    store.processHookEvent(makeEvent({ event: 'PreToolUse', status: 'running_tool', tool: 'Bash' }));
    expect(store.getSessions()[0].phase).toBe('processing');
  });

  it('handles compacting status', () => {
    store.processHookEvent(makeEvent({ event: 'PreCompact', status: 'compacting' }));
    expect(store.getSessions()[0].phase).toBe('compacting');
  });

  it('calls onChange for every event', () => {
    store.processHookEvent(makeEvent({ status: 'processing' }));
    store.processHookEvent(makeEvent({ event: 'Stop', status: 'waiting_for_input' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('updates lastActivity on each event', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    store.processHookEvent(makeEvent({ status: 'processing' }));
    const t1 = store.getSession('sess-1')!.lastActivity;

    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    store.processHookEvent(makeEvent({ event: 'Stop', status: 'waiting_for_input' }));
    const t2 = store.getSession('sess-1')!.lastActivity;

    expect(t2).toBeGreaterThan(t1);
  });

  describe('pruneDeadSessions', () => {
    it('marks sessions with dead PIDs as ended', () => {
      store.processHookEvent(makeEvent({ pid: 999999999 })); // non-existent PID
      expect(store.getSessions()).toHaveLength(1);

      store.pruneDeadSessions();

      // Session should be marked ended and filtered from getSessions
      expect(store.getSessions()).toHaveLength(0);
      expect(store.getSession('sess-1')!.phase).toBe('ended');
    });

    it('does not prune sessions with live PIDs', () => {
      store.processHookEvent(makeEvent({ pid: process.pid })); // our own PID, definitely alive
      store.pruneDeadSessions();
      expect(store.getSessions()).toHaveLength(1);
      expect(store.getSessions()[0].phase).toBe('processing');
    });

    it('does not prune already-ended sessions', () => {
      store.processHookEvent(makeEvent({ event: 'SessionEnd', status: 'ended' }));
      // Should not throw or double-prune
      store.pruneDeadSessions();
      expect(store.getSession('sess-1')!.phase).toBe('ended');
    });
  });

  describe('permission handling during interrupt', () => {
    it('Stop event does not clear pending permissions list', () => {
      // Permission request arrives
      store.processHookEvent(makeEvent({
        event: 'PreToolUse',
        status: 'waiting_for_approval',
        tool: 'Bash',
        tool_use_id: 'tu-1',
      }));
      expect(store.getSession('sess-1')!.pendingPermissions).toHaveLength(1);

      // User interrupts
      store.processHookEvent(makeEvent({ event: 'Stop', status: 'waiting_for_input' }));

      // Phase changes but permissions remain (socket close handler clears them)
      expect(store.getSession('sess-1')!.phase).toBe('waitingForInput');
    });

    it('removePermission does not override waitingForInput phase', () => {
      store.processHookEvent(makeEvent({
        event: 'PreToolUse',
        status: 'waiting_for_approval',
        tool: 'Bash',
        tool_use_id: 'tu-1',
      }));

      // Stop event arrives — phase changes to waitingForInput
      store.processHookEvent(makeEvent({ event: 'Stop', status: 'waiting_for_input' }));

      // Permission socket closes — removePermission fires
      store.removePermission('sess-1', 'tu-1');

      // Phase should still be waitingForInput, not processing
      expect(store.getSession('sess-1')!.phase).toBe('waitingForInput');
    });
  });
});
