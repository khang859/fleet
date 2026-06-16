import { describe, expect, it, vi } from 'vitest';
import { executeProposal } from '../proposal-executor';

function commandsStub() {
  return {
    mergeReviewTask: vi.fn(() => ({ ok: true })),
    createPrForTask: vi.fn(() => ({ ok: true })),
    acceptReviewTask: vi.fn(() => ({ ok: true })),
    shipFeature: vi.fn(() => ({ ok: true })),
    complete: vi.fn(),
    archive: vi.fn()
  };
}

describe('executeProposal', () => {
  it('runs complete_task via commands.complete', () => {
    const c = commandsStub();
    executeProposal(c as never, { kind: 'complete_task', targetId: 't1' } as never);
    expect(c.complete).toHaveBeenCalledWith('t1', expect.any(String));
  });

  it('runs merge_review_task via commands.mergeReviewTask', () => {
    const c = commandsStub();
    executeProposal(c as never, { kind: 'merge_review_task', targetId: 't2' } as never);
    expect(c.mergeReviewTask).toHaveBeenCalledWith('t2');
  });

  it('throws when a review action returns ok:false', () => {
    const c = commandsStub();
    c.mergeReviewTask = vi.fn(() => ({ ok: false, error: 'conflict' }));
    expect(() =>
      executeProposal(c as never, { kind: 'merge_review_task', targetId: 't3' } as never)
    ).toThrow('conflict');
  });
});
