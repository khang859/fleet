import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KanbanStore } from '../kanban-store';

function makeStore(): KanbanStore {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-proposals-'));
  return new KanbanStore(join(dir, 'kanban.db'), { now: () => 1000 });
}

describe('pm_proposals store', () => {
  it('creates, lists pending, and resolves a proposal', () => {
    const store = makeStore();
    const p = store.createProposal({
      boardId: 'b1',
      kind: 'complete_task',
      targetId: 't1',
      rationale: 'all subtasks done'
    });
    expect(p.status).toBe('pending');
    expect(p.error).toBeNull();
    expect(p.resolvedAt).toBeNull();

    expect(store.listProposals('b1', { status: 'pending' })).toHaveLength(1);

    store.resolveProposal(p.id, 'accepted', null);
    const after = store.getProposal(p.id);
    expect(after?.status).toBe('accepted');
    expect(after?.resolvedAt).toBe(1000);
    expect(store.listProposals('b1', { status: 'pending' })).toHaveLength(0);
  });

  it('records the error when a proposal fails', () => {
    const store = makeStore();
    const p = store.createProposal({
      boardId: 'b1',
      kind: 'merge_review_task',
      targetId: 't9',
      rationale: 'ready to merge'
    });
    store.resolveProposal(p.id, 'failed', 'merge conflict against main');
    expect(store.getProposal(p.id)?.error).toBe('merge conflict against main');
  });
});
