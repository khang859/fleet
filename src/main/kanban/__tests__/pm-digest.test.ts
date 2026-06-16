import { describe, expect, it } from 'vitest';
import { buildDigestContext } from '../pm-digest';
import type { TaskEvent } from '../../../shared/kanban-types';

function evt(kind: string, taskId: string): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

describe('buildDigestContext', () => {
  it('buckets events into completed / blocked / failures and counts proposals', () => {
    const ctx = buildDigestContext({
      events: [
        evt('completed', 'a'),
        evt('completed', 'b'),
        evt('blocked', 'c'),
        evt('verify_failed', 'd'),
        evt('gave_up', 'e')
      ],
      pendingProposals: 2,
      resolveTitle: (id) => `task ${id}`
    });
    expect(ctx).toContain('Completed (2)');
    expect(ctx).toContain('Blocked (1)');
    expect(ctx).toContain('Failures (2)');
    expect(ctx).toContain('2 proposal');
  });

  it('reports a quiet board', () => {
    const ctx = buildDigestContext({ events: [], pendingProposals: 0, resolveTitle: () => null });
    expect(ctx).toContain('No board activity');
  });
});
