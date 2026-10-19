import { create } from 'zustand';
import type { HoldRequest } from '../../../shared/agency-jobs';

/** A decision from the Bridge that main would not carry out, with its reason. */
export type RefusedDecision = {
  /** The queue item it was about: `plan:12`, `q:35`. */
  key: string;
  jobId: number | null;
  /** What the client tried, as a sentence start: `Approve plan v1`. */
  label: string;
  reason: string;
};

type BridgeState = {
  /** By repository, newest first, until the client dismisses one or decides on its item again. */
  refused: Record<string, RefusedDecision[]>;
  /**
   * Hold a plan or question decision for undo. The card that sent it leaves
   * the queue while it is held, so a refusal, at once or when its time
   * comes, lands here for the queue to show.
   */
  hold: (
    repoId: string,
    decision: Omit<RefusedDecision, 'reason'>,
    request: HoldRequest
  ) => Promise<void>;
  dismiss: (repoId: string, key: string) => void;
};

export const useBridgeStore = create<BridgeState>((set, get) => ({
  refused: {},
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
