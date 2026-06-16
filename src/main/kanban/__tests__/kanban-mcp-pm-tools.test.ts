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
  const store = { getTask: () => ({ id: 't1', boardId: 'b1' }) } as never;
  const server = new KanbanMcpServer(store, () => []);
  server.setCommands(commands as unknown as KanbanCommands);
  return { server, commands };
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

  it('kanban_unblock with guidance comments then unblocks', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest(
      'kanban_unblock',
      { task_id: 't1', guidance: 'use the new API' },
      scope
    );
    expect(commands.comment).toHaveBeenCalledWith('t1', expect.stringContaining('use the new API'));
    expect(commands.unblock).toHaveBeenCalledWith('t1');
  });

  it('kanban_reassign routes to assign', () => {
    const { server, commands } = makeServer();
    server.callPmToolForTest('kanban_reassign', { task_id: 't1', profile: 'backend' }, scope);
    expect(commands.assign).toHaveBeenCalledWith('t1', 'backend');
  });

  it('rejects an unknown tool', () => {
    const { server } = makeServer();
    expect(() => server.callPmToolForTest('kanban_nope', { task_id: 't1' }, scope)).toThrow();
  });

  it('rejects a missing task_id', () => {
    const { server } = makeServer();
    expect(() => server.callPmToolForTest('kanban_arm_decompose', {}, scope)).toThrow();
  });
});
