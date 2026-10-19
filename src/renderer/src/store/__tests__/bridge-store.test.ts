import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HoldRequest, HoldResult } from '../../../../shared/agency-jobs';
import { useBridgeStore } from '../bridge-store';

/** Decisions from the Bridge: held for undo, and kept with main's reason when refused. */

const REPO = '0123456789abcdef';
const APPROVE: HoldRequest = { kind: 'plan', action: { planVersionId: 7, action: 'approve' } };
const DECISION = { key: 'plan:7', jobId: 2, label: 'Approve plan v1' };

function answering(result: HoldResult | Error): ReturnType<typeof vi.fn> {
  const hold = vi.fn(async () =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  );
  window.fleet.agency = { hold } as unknown as typeof window.fleet.agency;
  return hold;
}

const refused = (): unknown => useBridgeStore.getState().refused[REPO] ?? [];

afterEach(() => useBridgeStore.setState({ refused: {} }));

describe('the bridge store', () => {
  it('sends the decision to be held, and keeps nothing when it ran or was undone', async () => {
    const hold = answering({ outcome: 'done' });
    await useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    expect(hold).toHaveBeenCalledWith(APPROVE);
    expect(refused()).toEqual([]);

    answering({ outcome: 'undone' });
    await useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    expect(refused()).toEqual([]);
  });

  it("keeps main's reason by the item's key, one per item, until dismissed or decided again", async () => {
    answering({ outcome: 'refused', reason: 'Plan v1 was replaced by v2.' });
    await useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    await useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    expect(refused()).toEqual([{ ...DECISION, reason: 'Plan v1 was replaced by v2.' }]);

    answering(new Error('Fleet closed'));
    await useBridgeStore
      .getState()
      .hold(REPO, { key: 'q:3', jobId: null, label: 'Answer q3' }, APPROVE);
    expect(refused()).toEqual([
      { key: 'q:3', jobId: null, label: 'Answer q3', reason: 'Error: Fleet closed' },
      { ...DECISION, reason: 'Plan v1 was replaced by v2.' }
    ]);

    useBridgeStore.getState().dismiss(REPO, 'q:3');
    expect(refused()).toEqual([{ ...DECISION, reason: 'Plan v1 was replaced by v2.' }]);

    const pending = useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    expect(refused()).toEqual([]);
    await pending;
  });
});
