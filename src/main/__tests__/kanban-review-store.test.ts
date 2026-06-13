import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const db = () => join(tmpdir(), `fleet-review-${Math.random()}.db`);

describe('review schema (migration 15)', () => {
  it('is at schema version 15 with review columns defaulting correctly', () => {
    const store = new KanbanStore(db(), { now: () => 1000 });
    expect(store.schemaVersion()).toBe(15);
    const t = store.createTask({ title: 'x' });
    const got = store.getTask(t.id)!;
    expect(got.reviewVerdict).toBeNull();
    expect(got.reviewAttempts).toBe(0);
    expect(got.reviewHeadSha).toBeNull();
    store.close();
  });
});
