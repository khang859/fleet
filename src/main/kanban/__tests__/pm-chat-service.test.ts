import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PmChatService } from '../pm-chat-service';
import type { KanbanMcpServer } from '../kanban-mcp-server';
import type { PmChatStatusPayload } from '../../../shared/ipc-api';

// The service imports { spawn } from 'child_process'; intercept it so we can drive
// the child lifecycle deterministically (no real `rune` binary needed).
const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

function makeService(overrides: {
  mcp?: Partial<KanbanMcpServer>;
  emitStatus?: (p: PmChatStatusPayload) => void;
}): PmChatService {
  const home = mkdtempSync(join(tmpdir(), 'fleet-pm-test-'));
  const mcp = {
    registerRun: vi.fn(),
    unregisterRun: vi.fn(),
    ...overrides.mcp
  } as unknown as KanbanMcpServer;
  return new PmChatService({
    mcp,
    mcpPort: 1234,
    kanbanHome: home,
    emitStatus: overrides.emitStatus ?? vi.fn(),
    emitTranscript: vi.fn(),
    getProjects: () => []
  });
}

function fakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe('PmChatService turn lifecycle', () => {
  it('resets inFlight and emits a terminal status when turn setup throws (no latched Thinking)', async () => {
    const emitStatus = vi.fn();
    const svc = makeService({
      // A failure during turn setup, before the child is spawned.
      mcp: {
        registerRun: vi.fn(() => {
          throw new Error('registry boom');
        })
      },
      emitStatus
    });

    // sendMessage is now fire-and-forget (the turn runs through the queue); setup
    // failures surface via emitStatus, not a synchronous throw.
    expect(() => svc.sendMessage('default', 'hello')).not.toThrow();

    // inFlight is cleared synchronously by finish(), so the board never latches.
    expect((await svc.getState('default')).inFlight).toBe(false);

    const statuses = (): string[] =>
      emitStatus.mock.calls.map((c) => (c[0] as PmChatStatusPayload).status);
    expect(statuses()[0]).toBe('thinking');
    // The terminal status is emitted after the (async) transcript read-back.
    await vi.waitFor(() => expect(statuses().at(-1)).toBe('error'));
  });

  it('escalates a hung turn from SIGTERM to SIGKILL when the child ignores SIGTERM', () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const svc = makeService({});

    svc.sendMessage('default', 'hi');

    // Per-turn timeout fires -> graceful SIGTERM first.
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    // Child ignores SIGTERM (never emits 'exit') -> escalate to SIGKILL after the grace period.
    vi.advanceTimersByTime(10 * 1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('PmChatService turn queue', () => {
  it('serializes turns: a second turn waits for the first to finish', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    spawnMock.mockImplementation(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const svc = makeService({});

    void svc.runTurn('b1', 'first', 'user');
    await Promise.resolve();
    expect(children).toHaveLength(1); // first turn spawned

    const second = svc.runTurn('b1', 'second', 'event');
    await Promise.resolve();
    expect(children).toHaveLength(1); // second is queued, NOT spawned yet

    children[0].emit('exit', 0, null); // finish the first turn
    // pump() defers to after the finishing turn's terminal status (async readMessages
    // .finally()), so the second turn spawns on a later tick.
    await vi.waitFor(() => expect(children).toHaveLength(2));

    children[1].emit('exit', 0, null); // finish the second turn
    await second; // runTurn resolves on turn completion
  });

  it('a new event turn supersedes an already-queued event turn', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    spawnMock.mockImplementation(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const svc = makeService({});

    // A user turn is in flight...
    void svc.runTurn('b1', 'user', 'user');
    await Promise.resolve();
    expect(children).toHaveLength(1);

    // ...two event turns queue behind it; the second supersedes the first.
    const firstEvent = svc.runTurn('b1', 'event-1', 'event');
    const secondEvent = svc.runTurn('b1', 'event-2', 'event');
    await Promise.resolve();
    expect(children).toHaveLength(1); // still only the user turn spawned

    // The superseded turn resolves cleanly (not rejected).
    await firstEvent;

    children[0].emit('exit', 0, null); // finish the user turn
    await vi.waitFor(() => expect(children).toHaveLength(2)); // exactly one event turn ran

    children[1].emit('exit', 0, null);
    await secondEvent;
    expect(children).toHaveLength(2);
  });
});
