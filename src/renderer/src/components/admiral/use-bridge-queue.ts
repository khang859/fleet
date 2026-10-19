import { useEffect } from 'react';
import type { AgencySnapshot } from '../../../../shared/agency';
import { useJobDetails } from '../../store/agency-store';
import {
  followReading,
  useBridgeStore,
  type Reading,
  type RefusedDecision
} from '../../store/bridge-store';
import { needsDetail, queueOrder, waitingItems, type WaitingItem } from './waiting-queue';

const NO_REFUSALS: RefusedDecision[] = [];

export type BridgeQueueState = {
  /** Everything that waits on the client across the project, in queue order. */
  items: WaitingItem[];
  /** Decisions from the Bridge main would not carry out, newest first. */
  refused: RefusedDecision[];
};

/**
 * The Bridge queue of a repository, loading the detail of each job with
 * items only its detail holds. Empty for no snapshot, as on a job tab.
 */
export function useBridgeQueue(snapshot: AgencySnapshot | undefined): BridgeQueueState {
  const details = useJobDetails((snapshot?.jobs ?? []).filter(needsDetail).map((j) => j.id));
  const refused = useBridgeStore((s) =>
    snapshot === undefined ? NO_REFUSALS : (s.refused[snapshot.repoId] ?? NO_REFUSALS)
  );
  return { items: queueOrder(waitingItems(snapshot, details)), refused };
}

/**
 * The item a pane's reader shows, kept on the queue as it changes: when the
 * item leaves, the reader moves to the one that took its place, and closes
 * once the queue is empty. `read` opens an item by its key, or closes on null.
 */
export function useQueueReading(
  paneId: string,
  items: readonly WaitingItem[]
): { reading: Reading | null; read: (key: string | null) => void } {
  const stored = useBridgeStore((s) => s.reading[paneId] ?? null);
  const keys = items.map((i) => i.key);
  const reading = followReading(keys, stored);
  useEffect(() => {
    if (reading !== stored) useBridgeStore.getState().read(paneId, reading);
  }, [paneId, reading, stored]);
  const read = (key: string | null): void => {
    const index = key === null ? -1 : keys.indexOf(key);
    if (key !== null && index < 0) return;
    useBridgeStore.getState().read(paneId, key === null ? null : { key, index });
  };
  return { reading, read };
}

/** Whether a key event belongs to a text field, where Esc and letters are the field's own. */
export function inTextField(target: EventTarget | null): boolean {
  return (
    target !== null &&
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}

/** Whether a key press closes the reader: Esc with no modifier, outside a text field. */
export function closesReader(e: {
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    e.key === 'Escape' &&
    !e.defaultPrevented &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !inTextField(e.target)
  );
}
