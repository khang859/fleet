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

    expect(() => svc.sendMessage('default', 'hello')).toThrow('registry boom');

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
