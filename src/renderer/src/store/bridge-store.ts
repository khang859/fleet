import { create } from 'zustand';
import type { AgencyAnswerRequest, AgencyJob, AgencyQuestion } from '../../../shared/agency';
import { questionDisplayId } from '../../../shared/agency';
import type { AgencyPlanVersion, HoldRequest } from '../../../shared/agency-jobs';

/** A decision from the Bridge that main would not carry out, with its reason. */
export type RefusedDecision = {
  /** The queue item it was about: `plan:12`, `q:35`. */
  key: string;
  jobId: number | null;
  /** What the client tried, as a sentence start: `Approve plan v1`. */
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

/** A plan decision the Bridge holds for undo: any but a direct edit. */
export type HeldPlanAction = Extract<HoldRequest, { kind: 'plan' }>['action'];

/** Hold a decision on a plan version from the Bridge, keyed as its queue item. */
export function holdPlan(
  job: AgencyJob,
  version: AgencyPlanVersion,
  label: string,
  action: HeldPlanAction
): void {
  void useBridgeStore
    .getState()
    .hold(
      job.repoId,
      { key: `plan:${version.id}`, jobId: job.id, label },
      { kind: 'plan', action }
    );
}

/** A change asked for or a rejection of a plan, held like the other plan decisions. */
export function holdPlanNote(
  job: AgencyJob,
  version: AgencyPlanVersion,
  action: 'revise' | 'reject',
  note: string,
  steps: string[]
): void {
  const name = `plan v${version.version}`;
  holdPlan(
    job,
    version,
    action === 'revise' ? `Ask for a change to ${name}` : `Reject ${name}`,
    action === 'revise'
      ? { planVersionId: version.id, action, note, steps }
      : { planVersionId: version.id, action, note }
  );
}

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
