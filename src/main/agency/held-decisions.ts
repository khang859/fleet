import type { HeldDecision } from '../../shared/agency';
import type { HoldRequest, HoldResult } from '../../shared/agency-jobs';
import { createLogger } from '../logger';
import type { AgencyTouched } from './store/agency-store';

const log = createLogger('agency:held');

/** How long a decision from the Bridge waits before Fleet carries it out, so the client can undo it. */
export const HOLD_MS = 5_000;

type Entry = HeldDecision & {
  repoId: string;
  request: HoldRequest;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (result: HoldResult) => void;
};

export type HeldDeps = {
  /** Carry a decision out through the path a card's own click takes. */
  run: (request: HoldRequest) => Promise<HoldResult>;
  changed: (touched: AgencyTouched[]) => void;
  now: () => number;
};

/**
 * Plan and question decisions the client gave from the Bridge, kept in
 * memory for `HOLD_MS` before they run, so Undo can drop one. Each `hold`
 * settles once its decision ran, was refused or was undone. A decision
 * stays listed while it runs, so its queue item does not come back for the
 * moment a check takes.
 */
export class HeldDecisions {
  private nextId = 1;
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly deps: HeldDeps) {}

  async hold(
    repoId: string,
    decision: Pick<HeldDecision, 'jobId' | 'key' | 'label'>,
    request: HoldRequest
  ): Promise<HoldResult> {
    if ([...this.entries.values()].some((e) => e.repoId === repoId && e.key === decision.key)) {
      return { outcome: 'refused', reason: 'A decision on this is already held.' };
    }
    const id = this.nextId++;
    return new Promise((settle) => {
      const entry: Entry = {
        ...decision,
        id,
        runsAt: this.deps.now() + HOLD_MS,
        repoId,
        request,
        timer: setTimeout(() => void this.run(id), HOLD_MS),
        settle
      };
      this.entries.set(id, entry);
      this.touch(entry);
    });
  }

  /** Drop a held decision. False once it has started to run, or when it is not known. */
  undo(id: number): boolean {
    const entry = this.entries.get(id);
    if (entry?.timer == null) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.settle({ outcome: 'undone' });
    this.touch(entry);
    return true;
  }

  /** Carry out at once every held decision of a repository, or of all, one at a time. */
  async runAll(repoId?: string): Promise<void> {
    const due = [...this.entries.values()].filter(
      (e) => e.timer !== null && (repoId === undefined || e.repoId === repoId)
    );
    for (const entry of due) await this.run(entry.id);
  }

  list(repoId: string): HeldDecision[] {
    return [...this.entries.values()]
      .filter((e) => e.repoId === repoId)
      .map(({ id, jobId, key, label, runsAt }) => ({ id, jobId, key, label, runsAt }));
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** The store is closing: drop what is still held, unrun. */
  stop(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.settle({ outcome: 'refused', reason: 'Fleet closed before it ran.' });
    }
    this.entries.clear();
  }

  private async run(id: number): Promise<void> {
    const entry = this.entries.get(id);
    if (entry?.timer == null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    let result: HoldResult;
    try {
      result = await this.deps.run(entry.request);
    } catch (err) {
      log.warn('a held decision failed', { key: entry.key, error: String(err) });
      result = { outcome: 'refused', reason: String(err) };
    }
    this.entries.delete(id);
    entry.settle(result);
    this.touch(entry);
  }

  private touch(entry: Entry): void {
    this.deps.changed([{ repoId: entry.repoId, jobId: entry.jobId }]);
  }
}
