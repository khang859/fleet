import { create } from 'zustand';
import type { AgencyAnswerRequest, AgencyQuestion } from '../../../shared/agency';
import { questionDisplayId } from '../../../shared/agency';
import type { HoldRequest } from '../../../shared/agency-jobs';

/** A decision from the Bridge that main would not carry out, with its reason. */
export type RefusedDecision = {
  /** The queue item it was about, such as `q:35`. */
  key: string;
  jobId: number | null;
  /** What the client tried, as a sentence start: `Answer q35`. */
  label: string;
  reason: string;
};

/** The queue item a pane's reader shows, and its place in the queue when last seen. */
export type Reading = { key: string; index: number };

/**
 * What the reader shows once the queue changes: the same item where it is
 * now, else the item that took its place, or nothing when the queue is empty.
 */
export function followReading(keys: readonly string[], reading: Reading | null): Reading | null {
  if (reading === null || keys.length === 0) return null;
  const at = keys.indexOf(reading.key);
  if (at >= 0) return at === reading.index ? reading : { key: reading.key, index: at };
  const index = Math.min(reading.index, keys.length - 1);
  return { key: keys[index], index };
}

type BridgeState = {
  /** By repository, newest first, until the client dismisses one or decides on its item again. */
  refused: Record<string, RefusedDecision[]>;
  /**
   * Hold a question answer for undo. The card that sent it leaves
   * the queue while it is held, so a refusal, at once or when its time
   * comes, lands here for the queue to show.
   */
  hold: (
    repoId: string,
    decision: Omit<RefusedDecision, 'reason'>,
    request: HoldRequest
  ) => Promise<void>;
  dismiss: (repoId: string, key: string) => void;
  /** By pane: the item its reader shows in the main column; absent while the conversation shows. */
  reading: Record<string, Reading>;
  read: (paneId: string, reading: Reading | null) => void;
};

export const useBridgeStore = create<BridgeState>((set, get) => ({
  refused: {},
  reading: {},
  read: (paneId, reading) =>
    set((s) => ({
      reading:
        reading === null
          ? Object.fromEntries(Object.entries(s.reading).filter(([id]) => id !== paneId))
          : { ...s.reading, [paneId]: reading }
    })),
  hold: async (repoId, decision, request) => {
    get().dismiss(repoId, decision.key);
    const result = await window.fleet.agency
      .hold(request)
      .catch((err: unknown) => ({ outcome: 'refused' as const, reason: String(err) }));
    if (result.outcome !== 'refused') return;
    set((s) => ({
      refused: {
        ...s.refused,
        [repoId]: [
          { ...decision, reason: result.reason },
          ...(s.refused[repoId] ?? []).filter((r) => r.key !== decision.key)
        ]
      }
    }));
  },
  dismiss: (repoId, key) =>
    set((s) => {
      const list = s.refused[repoId] ?? [];
      if (!list.some((r) => r.key === key)) return s;
      return { refused: { ...s.refused, [repoId]: list.filter((r) => r.key !== key) } };
    })
}));

/**
 * A question card's answer from the Bridge: held for undo, and taken at once,
 * since the card leaves the queue without waiting on the hold.
 */
export function holdAnswer(
  repoId: string,
  question: AgencyQuestion
): (answer: Omit<AgencyAnswerRequest, 'id'>) => Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return (answer) => {
    void useBridgeStore.getState().hold(
      repoId,
      {
        key: `q:${question.id}`,
        jobId: question.jobId,
        label: `Answer ${questionDisplayId(question.id)}`
      },
      { kind: 'answer', answer: { id: question.id, ...answer } }
    );
    return Promise.resolve(true);
  };
}
