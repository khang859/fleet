import { describe, expect, it, vi } from 'vitest';
import { KanbanMcpServer } from '../kanban-mcp-server';
import type { KanbanCommands } from '../kanban-commands';

function makeServer() {
  const commands = {
    requestDecompose: vi.fn(),
    requestSpecify: vi.fn(),
    unblock: vi.fn(),
    comment: vi.fn(),
    assign: vi.fn(),
    proposeAction: vi.fn(),
    setManualStatus: vi.fn()
  };
  const store = {
    getTask: vi.fn(() => ({ id: 't1', boardId: 'b1' })),
    addComment: vi.fn(),
    appendEvent: vi.fn()
  };
  const profiles = [{ name: 'backend', role: 'worker' as const }];
  const server = new KanbanMcpServer(store as never, () => profiles);
  server.setCommands(commands as unknown as KanbanCommands);
  return { server, commands, store };
}

const scope = { kind: 'board', boardId: 'b1' } as const;

describe('PM safe tools', () => {
  it('kanban_arm_decompose routes to requestDecompose', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_arm_decompose', { task_id: 't1' }, scope);
    expect(commands.requestDecompose).toHaveBeenCalledWith('t1');
  });

  it('kanban_arm_specify routes to requestSpecify', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_arm_specify', { task_id: 't1' }, scope);
    expect(commands.requestSpecify).toHaveBeenCalledWith('t1');
  });

  it('kanban_unblock without guidance just unblocks', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_unblock', { task_id: 't1' }, scope);
    expect(commands.comment).not.toHaveBeenCalled();
    expect(commands.unblock).toHaveBeenCalledWith('t1');
  });

  it('kanban_unblock with guidance writes a pm comment then unblocks', () => {
    const { server, commands, store } = makeServer();
    server.callPmToolForTest(
      'kanban_unblock',
      { task_id: 't1', guidance: 'use the new API' },
      scope
    );
    expect(commands.comment).not.toHaveBeenCalled();
    expect(store.addComment).toHaveBeenCalledWith(
      't1',
      'pm',
      expect.stringContaining('use the new API')
    );
    expect(commands.unblock).toHaveBeenCalledWith('t1');
  });

  it('kanban_reassign routes to assign for a known worker profile', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_reassign', { task_id: 't1', profile: 'backend' }, scope);
    expect(commands.assign).toHaveBeenCalledWith('t1', 'backend');
  });

  it('kanban_reassign rejects an unknown worker profile', () => {
    const { server, commands } = makeServer();
    expect(() =>
      server.callPmToolForTest('kanban_reassign', { task_id: 't1', profile: 'ghost' }, scope)
    ).toThrow(/unknown worker profile/);
    expect(commands.assign).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool', () => {
    const { server } = makeServer();
    expect(() => server.callPmToolForTest('kanban_nope', { task_id: 't1' }, scope)).toThrow();
  });

  it('rejects a missing task_id', () => {
    const { server } = makeServer();
    expect(() => server.callPmToolForTest('kanban_arm_decompose', {}, scope)).toThrow();
  });

  it('rejects a task on a different board', () => {
    const { server } = makeServer();
    const otherBoard = { kind: 'board', boardId: 'b2' } as const;
    expect(() =>
      server.callPmToolForTest('kanban_arm_decompose', { task_id: 't1' }, otherBoard)
    ).toThrow(/task not found on this board/);
  });
});

describe('PM propose + guardrail', () => {
  it('kanban_propose writes a proposal via commands', () => {
    const { server, commands } = makeServer();
    commands.proposeAction = vi.fn(() => ({ id: 'p1' }));
    const out = server.callPmToolForTest(
      'kanban_propose',
      { kind: 'complete_task', target_id: 't1', rationale: 'done' },
      scope
    );
    expect(commands.proposeAction).toHaveBeenCalledWith('b1', 'complete_task', 't1', 'done');
    expect(out).toMatch(/p1/);
  });

  it('kanban_propose rejects a task on a different board', () => {
    const { server, store, commands } = makeServer();
    store.getTask = vi.fn(() => ({ id: 't1', boardId: 'b2' }));
    expect(() =>
      server.callPmToolForTest(
        'kanban_propose',
        { kind: 'complete_task', target_id: 't1', rationale: 'x' },
        scope
      )
    ).toThrow(/task not found on this board/);
    expect(commands.proposeAction).not.toHaveBeenCalled();
  });

  it('rejects an unknown proposal kind', () => {
    const { server } = makeServer();
    expect(() =>
      server.callPmToolForTest(
        'kanban_propose',
        { kind: 'nuke', target_id: 't1', rationale: 'x' },
        scope
      )
    ).toThrow();
  });

  it('set_status to done on a worktree task is rejected', () => {
    const { server, store, commands } = makeServer();
    store.getTask = vi.fn(() => ({ id: 't1', boardId: 'b1', workspaceKind: 'worktree' }));
    expect(() =>
      server.callPmToolForTest('kanban_set_status', { task_id: 't1', status: 'done' }, scope)
    ).toThrow(/propose/);
    expect(commands.setManualStatus).not.toHaveBeenCalled();
  });

  it('set_status to done on a scratch task is allowed', () => {
    const { server, store, commands } = makeServer();
    store.getTask = vi.fn(() => ({ id: 't1', boardId: 'b1', workspaceKind: 'scratch' }));
    server.callPmToolForTest('kanban_set_status', { task_id: 't1', status: 'done' }, scope);
    expect(commands.setManualStatus).toHaveBeenCalledWith('t1', 'done');
  });

  it('set_status to ready on a worktree task is allowed', () => {
    const { server, store, commands } = makeServer();
    store.getTask = vi.fn(() => ({ id: 't1', boardId: 'b1', workspaceKind: 'worktree' }));
    server.callPmToolForTest('kanban_set_status', { task_id: 't1', status: 'ready' }, scope);
    expect(commands.setManualStatus).toHaveBeenCalledWith('t1', 'ready');
  });
});
