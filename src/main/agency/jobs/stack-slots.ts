import type { AgencyJob } from '../../../shared/agency';
import { loadSetup } from '../projects/project-store';
import type { AgencyStore } from '../store/agency-store';
import { Ticker } from '../ticker';
import { portFree } from '../workspaces/port-blocks';

/** How often steps waiting for a stack slot check whether a fixed port came free. */
export const STACK_POLL_MS = 10_000;

/** A project's stack slots, and the slots taken, for a step whose role runs the stack. */
export type StackGate = {
  slots: number;
  held: number;
  /** A fixed port a program outside Fleet listens on, which takes a slot. */
  outsidePort: number | null;
};

type Known = { slots: number | null; busyPort: number | null };

/**
 * The project's limit on steps that run the stack (`stack: true` roles) at
 * once. Starting a step asks synchronously, so what the setup says and
 * whether a fixed port is taken are read ahead: before each hire, and every
 * few seconds while a step waits for a slot. A fixed port taken while no
 * crew member of the project runs the stack is a program outside the jobs,
 * which Fleet never stops: it holds a slot until it lets the port go.
 */
export class StackSlots {
  private readonly known = new Map<string, Known>();

  private readonly ticker = new Ticker();

  constructor(
    private readonly deps: {
      store: AgencyStore;
      home: () => string;
      /** Let queued steps go: run after a poll, as a fixed port may have come free. */
      admit: () => void;
      portFree?: (port: number) => Promise<boolean>;
    }
  ) {}

  /** Whether a step of the job's approved plan has a role that runs the stack. */
  runsStack(jobId: number, stepId: string): boolean {
    const approved = this.deps.store.plans.approved(jobId);
    const step = approved?.plan.steps.find((s) => s.id === stepId);
    return approved?.crew?.roles.find((r) => r.name === step?.role)?.stack === true;
  }

  /**
   * The slots of a step that runs the stack, with `admitted` more steps let
   * go but not hired yet; null when the step waits on no slot.
   */
  gate(job: AgencyJob, stepId: string, admitted = 0): StackGate | null {
    const known = this.known.get(job.repoId);
    if (known?.slots == null || !this.runsStack(job.id, stepId)) return null;
    const running = this.deps.store.crew
      .live()
      .filter((c) => this.deps.store.getJob(c.jobId)?.repoId === job.repoId)
      .filter((c) => this.runsStack(c.jobId, c.stepId)).length;
    const outsidePort = running === 0 ? known.busyPort : null;
    return {
      slots: known.slots,
      held: running + admitted + (outsidePort === null ? 0 : 1),
      outsidePort
    };
  }

  /** Read the project's stack slots and test its fixed ports again. */
  async refresh(repoId: string): Promise<void> {
    const setup = await loadSetup(repoId, this.deps.home());
    const fixed = [...new Set(setup?.members.flatMap((m) => m.fixedPorts.map((f) => f.port)))];
    let busyPort: number | null = null;
    for (const port of fixed) {
      if (!(await (this.deps.portFree ?? portFree)(port))) {
        busyPort = port;
        break;
      }
    }
    this.known.set(repoId, { slots: setup?.stackSlots ?? null, busyPort });
  }

  /** Check the projects of steps waiting for a slot, then let the ones that may start go. */
  async poll(): Promise<void> {
    const { store } = this.deps;
    const waiting = store.plans.queuedSteps().filter((q) => this.runsStack(q.jobId, q.stepId));
    const repos = new Set(waiting.flatMap((q) => store.getJob(q.jobId)?.repoId ?? []));
    if (repos.size === 0) return;
    await Promise.all([...repos].map(async (repoId) => this.refresh(repoId)));
    this.deps.admit();
  }

  startPolling(intervalMs = STACK_POLL_MS): void {
    this.ticker.start(() => void this.poll(), intervalMs);
  }

  stopPolling(): void {
    this.ticker.stop();
  }
}
