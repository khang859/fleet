import { describe, expect, it, vi } from 'vitest';
import { KanbanMcpServer } from '../kanban-mcp-server';
import type { KanbanCommands } from '../kanban-commands';

function makeServer() {
  const commands = {
    requestDecompose: vi.fn(),
    requestSpecify: vi.fn(),
    unblock: vi.fn(),
    comment: vi.fn(),
    assign: vi.fn()
  };
  const store = {
    getTask: () => ({ id: 't1', boardId: 'b1' }),
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
