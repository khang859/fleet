import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HoldRequest, HoldResult } from '../../../../shared/agency-jobs';
import { followReading, useBridgeStore } from '../bridge-store';

/** Decisions from the Bridge: held for undo, and kept with main's reason when refused. */

const REPO = '0123456789abcdef';
const APPROVE: HoldRequest = { kind: 'answer', answer: { id: 7, option: 0 } };
const DECISION = { key: 'q:7', jobId: 2, label: 'Answer q7' };

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
    answering({ outcome: 'refused', reason: 'q7 was answered already.' });
    await useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    await useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    expect(refused()).toEqual([{ ...DECISION, reason: 'q7 was answered already.' }]);

    answering(new Error('Fleet closed'));
    await useBridgeStore
      .getState()
      .hold(REPO, { key: 'q:3', jobId: null, label: 'Answer q3' }, APPROVE);
    expect(refused()).toEqual([
      { key: 'q:3', jobId: null, label: 'Answer q3', reason: 'Error: Fleet closed' },
      { ...DECISION, reason: 'q7 was answered already.' }
    ]);

    useBridgeStore.getState().dismiss(REPO, 'q:3');
    expect(refused()).toEqual([{ ...DECISION, reason: 'q7 was answered already.' }]);

    const pending = useBridgeStore.getState().hold(REPO, DECISION, APPROVE);
    expect(refused()).toEqual([]);
    await pending;
  });
});

describe('the reader on a changing queue', () => {
  const keys = ['perm:5', 'delivered:7', 'q:35'];

  it('stays on its item, wherever the item moves', () => {
    const reading = { key: 'delivered:7', index: 1 };
    expect(followReading(keys, reading)).toBe(reading);
    expect(followReading(['q:35', 'perm:5', 'delivered:7'], reading)).toEqual({
      key: 'delivered:7',
      index: 2
    });
  });

  it('moves to the item that took its place once its item is resolved', () => {
    expect(followReading(['perm:5', 'q:35'], { key: 'delivered:7', index: 1 })).toEqual({
      key: 'q:35',
      index: 1
    });
    // The last item gone: the one before it is now last.
    expect(followReading(['perm:5', 'delivered:7'], { key: 'q:35', index: 2 })).toEqual({
      key: 'delivered:7',
      index: 1
    });
  });

  it('closes once the queue is empty, and stays closed', () => {
    expect(followReading([], { key: 'q:35', index: 0 })).toBeNull();
    expect(followReading(keys, null)).toBeNull();
  });

  it('is kept by pane, and closing one pane leaves the others', () => {
    const { read } = useBridgeStore.getState();
    read('pane-a', { key: 'q:35', index: 2 });
    read('pane-b', { key: 'perm:5', index: 0 });
    read('pane-a', null);
    expect(useBridgeStore.getState().reading).toEqual({ 'pane-b': { key: 'perm:5', index: 0 } });
    read('pane-b', null);
  });
});
