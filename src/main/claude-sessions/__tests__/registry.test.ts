import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSessionChange } from '../../../shared/claude-sessions';
import type { HookEvent } from '../hook-events';
import { ClaudeSessionRegistry, hashPrompt, type Clock } from '../registry';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

/** A clock whose time and timers only move when the test says so. */
function fakeClock(): Clock & { advance(ms: number): void; pending(): number } {
  let now = 1_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size
  };
}

const ev = (overrides: Partial<HookEvent> = {}): HookEvent => ({
  sessionId: 's1',
  cwd: '/home/u/repo',
  event: 'UserPromptSubmit',
  status: 'processing',
  pid: 4242,
  protocol: 2,
  ...overrides
});

const pane = { paneId: 'pane-1', workspaceId: 'ws-1', workspaceName: 'Main' };

describe('ClaudeSessionRegistry', () => {
  let clock: ReturnType<typeof fakeClock>;
  let alive: Set<number>;
  let registry: ClaudeSessionRegistry;
  let changes: ClaudeSessionChange[];

  beforeEach(() => {
    clock = fakeClock();
    alive = new Set([4242]);
    registry = new ClaudeSessionRegistry({
      clock,
      isAlive: (pid) => alive.has(pid),
      eventLimit: 5,
      endedRetentionMs: 30_000
    });
    changes = [];
    registry.subscribe((change) => changes.push(change));
  });

  it('tracks a session in the pane it was placed in', () => {
    registry.ingest(ev({ transcriptPath: '/c/projects/-repo/s1.jsonl', configDir: '/c' }), pane);

    expect(registry.list()).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        paneId: 'pane-1',
        epoch: 1,
        projectName: 'repo',
        phase: 'processing',
        workspaceId: 'ws-1',
        transcriptPath: '/c/projects/-repo/s1.jsonl',
        configDir: '/c'
      })
    ]);
    expect(registry.getByPane('pane-1')?.sessionId).toBe('s1');
    expect(registry.getByPane('pane-2')).toBeUndefined();
  });

  it('records when the phase last changed, not when the last event came', () => {
    registry.ingest(ev(), pane);
    clock.advance(500);
    registry.ingest(ev({ event: 'PreToolUse', status: 'running_tool', tool: 'Bash' }), pane);
    expect(registry.get('s1')?.phaseSince).toBe(1_000);
    expect(registry.get('s1')?.lastActivity).toBe(1_500);

    clock.advance(500);
    registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);
    expect(registry.get('s1')?.phaseSince).toBe(2_000);
  });

  it('replaces the session object on every change', () => {
    registry.ingest(ev(), pane);
    const first = registry.get('s1');
    registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);
    expect(registry.get('s1')).not.toBe(first);
    expect(first?.phase).toBe('processing');
  });

  it('keeps a workspace it learned when later events come without one', () => {
    registry.ingest(ev(), { paneId: 'pane-1' });
    expect(registry.get('s1')?.workspaceId).toBeUndefined();
    registry.ingest(ev(), pane);
    registry.ingest(ev(), { paneId: 'pane-1' });
    expect(registry.get('s1')?.workspaceId).toBe('ws-1');
  });

  describe('events', () => {
    it('hands out events after a sequence number, oldest first', () => {
      registry.ingest(ev(), pane);
      registry.ingest(ev({ event: 'PreToolUse', status: 'running_tool', tool: 'Read' }), pane);
      const [first] = registry.eventsAfter('s1', 0);
      registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);

      expect(registry.eventsAfter('s1', first.seq).map((e) => [e.event, e.phase])).toEqual([
        ['PreToolUse', 'processing'],
        ['Stop', 'waitingForInput']
      ]);
      expect(registry.eventsAfter('s1', registry.lastSeq())).toEqual([]);
    });

    it('keeps only the newest events up to the limit', () => {
      for (let i = 0; i < 8; i++) registry.ingest(ev({ message: String(i) }), pane);
      expect(registry.eventsAfter('s1', 0).map((e) => e.message)).toEqual([
        '3',
        '4',
        '5',
        '6',
        '7'
      ]);
    });

    it('tells subscribers which event changed which session', () => {
      registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);
      expect(changes).toHaveLength(1);
      expect(changes[0].session?.phase).toBe('waitingForInput');
      expect(changes[0].event?.event).toBe('Stop');
    });

    it('keeps notifying other subscribers when one throws', () => {
      registry.subscribe(() => {
        throw new Error('boom');
      });
      const later: ClaudeSessionChange[] = [];
      registry.subscribe((c) => later.push(c));
      registry.ingest(ev(), pane);
      expect(later).toHaveLength(1);
    });

    it('stops notifying after unsubscribe', () => {
      const seen: ClaudeSessionChange[] = [];
      const off = registry.subscribe((c) => seen.push(c));
      off();
      registry.ingest(ev(), pane);
      expect(seen).toEqual([]);
    });
  });

  describe('permissions', () => {
    it('matches a permission request to the tool use id seen on PreToolUse', () => {
      const toolInput = { command: 'npm test' };
      registry.ingest(
        ev({
          event: 'PreToolUse',
          status: 'running_tool',
          tool: 'Bash',
          toolInput,
          toolUseId: 'tu-1'
        }),
        pane
      );
      registry.ingest(
        ev({ event: 'PermissionRequest', status: 'waiting_for_approval', tool: 'Bash', toolInput }),
        pane
      );

      const session = registry.get('s1');
      expect(session?.phase).toBe('waitingForApproval');
      expect(session?.pendingPermissions.map((p) => p.toolUseId)).toEqual(['tu-1']);
    });

    it('does not hand a later request the id of a tool that never finished', () => {
      const toolInput = { command: 'rm -rf build' };
      const pre = (toolUseId: string): HookEvent =>
        ev({ event: 'PreToolUse', status: 'running_tool', tool: 'Bash', toolInput, toolUseId });
      // Denied in the terminal: no PostToolUse, and the turn ends.
      registry.ingest(pre('tu-old'), pane);
      registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);

      registry.ingest(ev(), pane);
      registry.ingest(pre('tu-new'), pane);
      registry.ingest(
        ev({ event: 'PermissionRequest', status: 'waiting_for_approval', tool: 'Bash', toolInput }),
        pane
      );
      expect(registry.get('s1')?.pendingPermissions.map((p) => p.toolUseId)).toEqual(['tu-new']);
    });

    it('goes back to work when a permission is answered from Fleet', () => {
      registry.ingest(
        ev({
          event: 'PermissionRequest',
          status: 'waiting_for_approval',
          tool: 'Bash',
          toolUseId: 'tu-1'
        }),
        pane
      );
      clock.advance(10);
      registry.resolvePermission('s1', 'tu-1');
      expect(registry.get('s1')).toMatchObject({
        phase: 'processing',
        pendingPermissions: [],
        phaseSince: 1_010
      });
    });

    it('settles a phase the transcript showed, without a hook event', () => {
      registry.ingest(
        ev({
          event: 'PermissionRequest',
          status: 'waiting_for_approval',
          tool: 'Bash',
          toolUseId: 'tu-1'
        }),
        pane
      );
      changes.length = 0;
      clock.advance(10);
      registry.settle('s1', 'turnStopped');
      expect(registry.get('s1')).toMatchObject({
        phase: 'waitingForInput',
        waitingKind: 'prompt',
        pendingPermissions: [],
        phaseSince: 1_010
      });
      expect(changes).toEqual([expect.objectContaining({ sessionId: 's1', event: null })]);
      // Nothing to settle: no change is announced.
      registry.settle('s1', 'turnStopped');
      expect(changes).toHaveLength(1);
      registry.settle('s1', 'turnStarted');
      expect(registry.get('s1')?.phase).toBe('processing');
    });

    it('does not settle an ended session', () => {
      registry.ingest(ev(), pane);
      registry.releasePane('pane-1');
      registry.settle('s1', 'turnStopped');
      expect(registry.get('s1')?.phase).toBe('ended');
    });
  });

  describe('epochs', () => {
    it('ends the old session and bumps the epoch when /clear starts a new one', () => {
      registry.ingest(ev(), pane);
      registry.ingest(
        ev({
          sessionId: 's2',
          event: 'SessionStart',
          status: 'waiting_for_input',
          source: 'clear'
        }),
        pane
      );

      expect(registry.get('s1')?.phase).toBe('ended');
      expect(registry.get('s2')).toMatchObject({ epoch: 2, phase: 'waitingForInput' });
      expect(registry.list().map((s) => s.sessionId)).toEqual(['s2']);
      expect(registry.getByPane('pane-1')?.sessionId).toBe('s2');
    });

    it('keeps the pane session when a nested claude runs in the same pane', () => {
      alive.add(5000);
      registry.ingest(ev(), pane);
      const nested = (overrides: Partial<HookEvent>): HookEvent =>
        ev({ sessionId: 'nested', pid: 5000, ...overrides });
      registry.ingest(
        nested({ event: 'SessionStart', status: 'waiting_for_input', source: 'startup' }),
        pane
      );
      registry.ingest(nested({ event: 'SessionEnd', status: 'ended' }), pane);
      registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);

      expect(registry.get('s1')).toMatchObject({ phase: 'waitingForInput', epoch: 1 });
      expect(registry.get('nested')).toMatchObject({ phase: 'ended', epoch: 1 });
      expect(registry.getByPane('pane-1')?.sessionId).toBe('s1');
    });

    it('hands the pane to a new claude once the old process is gone', () => {
      alive.add(5000);
      registry.ingest(ev(), pane);
      alive.delete(4242);
      registry.ingest(
        ev({ sessionId: 's2', pid: 5000, event: 'SessionStart', status: 'waiting_for_input' }),
        pane
      );
      expect(registry.get('s1')?.phase).toBe('ended');
      expect(registry.getByPane('pane-1')).toMatchObject({ sessionId: 's2', epoch: 2 });
    });

    it('ignores late events from a session that has ended', () => {
      registry.ingest(ev(), pane);
      registry.ingest(
        ev({ sessionId: 's2', event: 'SessionStart', status: 'waiting_for_input' }),
        pane
      );
      registry.ingest(ev({ event: 'SessionEnd', status: 'ended' }), pane);
      registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), pane);

      expect(registry.get('s1')?.phase).toBe('ended');
      expect(registry.getByPane('pane-1')?.sessionId).toBe('s2');
    });

    it('revives a session that is resumed before it is dropped', () => {
      registry.ingest(ev({ event: 'SessionEnd', status: 'ended' }), pane);
      registry.ingest(
        ev({ event: 'SessionStart', status: 'waiting_for_input', source: 'resume' }),
        { paneId: 'pane-2' }
      );

      clock.advance(60_000);
      expect(registry.get('s1')).toMatchObject({
        phase: 'waitingForInput',
        paneId: 'pane-2',
        epoch: 1
      });
    });
  });

  describe('ending', () => {
    it('drops an ended session after the retention time', () => {
      registry.ingest(ev({ event: 'SessionEnd', status: 'ended' }), pane);
      expect(registry.list()).toEqual([]);
      expect(registry.get('s1')?.phase).toBe('ended');

      clock.advance(30_000);
      expect(registry.get('s1')).toBeUndefined();
      expect(changes.at(-1)).toEqual({ sessionId: 's1', session: null, event: null });
    });

    it('ends a session whose process exited without an end event', () => {
      registry.ingest(ev(), pane);
      alive.delete(4242);
      registry.pruneDead();
      expect(registry.get('s1')?.phase).toBe('ended');
    });

    it('leaves live sessions alone when pruning', () => {
      registry.ingest(ev(), pane);
      registry.pruneDead();
      expect(registry.get('s1')?.phase).toBe('processing');
      expect(changes).toHaveLength(1);
    });

    it('ends what ran in a pane when the pane closes', () => {
      registry.ingest(ev(), pane);
      registry.releasePane('pane-1');
      expect(registry.get('s1')?.phase).toBe('ended');
      expect(registry.getByPane('pane-1')).toBeUndefined();
    });

    it('clears its timers on dispose', () => {
      registry.ingest(ev({ event: 'SessionEnd', status: 'ended' }), pane);
      expect(clock.pending()).toBe(1);
      registry.dispose();
      expect(clock.pending()).toBe(0);
      expect(registry.list()).toEqual([]);
    });
  });

  it('notes who typed a prompt without keeping the text', () => {
    registry.ingest(ev(), pane);
    registry.noteInput('s1', 'orchestrator', '[orchestrator] run the tests');
    expect(registry.inputsFor('s1')).toEqual([
      { origin: 'orchestrator', hash: hashPrompt('[orchestrator] run the tests'), at: 1_000 }
    ]);
    expect(JSON.stringify(registry.inputsFor('s1'))).not.toContain('run the tests');
  });
});

describe('ClaudeSessionRegistry ingest result', () => {
  const place = { paneId: 'pane-1' };

  it('returns the recorded event, with a local id for a permission Claude did not name', () => {
    const registry = new ClaudeSessionRegistry({ isAlive: () => true });
    const recorded = registry.ingest(
      ev({ event: 'PermissionRequest', status: 'waiting_for_approval', tool: 'Bash' }),
      place
    );
    expect(recorded?.toolUseId).toMatch(/^unknown-/);
    expect(registry.get('s1')?.pendingPermissions[0]?.toolUseId).toBe(recorded?.toolUseId);
    registry.dispose();
  });

  it('returns null for an event it ignored', () => {
    const registry = new ClaudeSessionRegistry({ isAlive: () => true });
    registry.ingest(ev({ event: 'SessionEnd', status: 'ended' }), place);
    expect(registry.ingest(ev({ event: 'Stop', status: 'waiting_for_input' }), place)).toBeNull();
    registry.dispose();
  });

  it('tells subscribers every session left on clear', () => {
    const registry = new ClaudeSessionRegistry({ isAlive: () => true });
    registry.ingest(ev(), place);
    registry.ingest(ev({ sessionId: 's2' }), { paneId: 'pane-2' });
    const left: string[] = [];
    registry.subscribe((c) => c.session === null && left.push(c.sessionId));
    registry.clear();
    expect(left).toEqual(['s1', 's2']);
    expect(registry.list()).toEqual([]);
    registry.dispose();
  });
});
