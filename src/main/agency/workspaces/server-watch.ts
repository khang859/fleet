import { connect } from 'node:net';
import type { AgencyServer } from '../../../shared/agency-jobs';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { Ticker } from '../ticker';

/** How often the ports of workspaces with crew at work are checked for servers. */
export const SERVER_POLL_MS = 5_000;

/** Resolves true when a server takes connections on the port, on IPv4 or IPv6 loopback. */
export async function listening(port: number): Promise<boolean> {
  const on = async (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ port, host });
      const done = (open: boolean): void => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(500, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  const [v4, v6] = await Promise.all([on('127.0.0.1'), on('::1')]);
  return v4 || v6;
}

/**
 * The servers crew members start, for the job sheet: every few seconds, each
 * port of the block of each workspace with a crew member at work is tried,
 * and a job's list changes only when a server comes or goes.
 */
export class ServerWatch {
  private readonly found = new Map<number, AgencyServer[]>();

  private readonly ticker = new Ticker();

  private checking = false;

  constructor(
    private readonly deps: {
      store: AgencyStore;
      changed: (touched: AgencyTouched[]) => void;
      listening?: (port: number) => Promise<boolean>;
    }
  ) {}

  /** A job's servers as last seen, by port. */
  servers(jobId: number): AgencyServer[] {
    return this.found.get(jobId) ?? [];
  }

  /** Try the ports again, and raise a change for each job whose servers changed. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      this.settle(await this.look());
    } finally {
      this.checking = false;
    }
  }

  private async look(): Promise<Map<number, AgencyServer[]>> {
    const { store } = this.deps;
    const workspaces = new Map<number, number>();
    for (const c of store.crew.live()) {
      if (c.workspaceId !== null) workspaces.set(c.workspaceId, c.jobId);
    }
    const now = new Map<number, AgencyServer[]>();
    for (const [workspaceId, jobId] of workspaces) {
      const block = store.resources.workspacePorts(workspaceId);
      if (block === null) continue;
      const names = new Map(
        Object.entries(store.resources.workspaceEnv(workspaceId)).map(([k, v]) => [v, k])
      );
      const ports = Array.from({ length: block.size }, (_, i) => block.start + i);
      const open = await Promise.all(ports.map(async (p) => (this.deps.listening ?? listening)(p)));
      const servers = ports
        .filter((_, i) => open[i])
        .map((port) => ({
          stepId: block.stepId,
          name: names.get(String(port)) ?? null,
          port,
          url: `http://localhost:${port}`
        }));
      now.set(
        jobId,
        [...(now.get(jobId) ?? []), ...servers].sort((a, b) => a.port - b.port)
      );
    }
    return now;
  }

  private settle(now: Map<number, AgencyServer[]>): void {
    const touched: AgencyTouched[] = [];
    for (const jobId of new Set([...this.found.keys(), ...now.keys()])) {
      const after = now.get(jobId) ?? [];
      if (JSON.stringify(this.found.get(jobId) ?? []) === JSON.stringify(after)) continue;
      if (after.length === 0) this.found.delete(jobId);
      else this.found.set(jobId, after);
      const repoId = this.deps.store.getJob(jobId)?.repoId;
      if (repoId !== undefined) touched.push({ repoId, jobId });
    }
    if (touched.length > 0) this.deps.changed(touched);
  }

  startPolling(intervalMs = SERVER_POLL_MS): void {
    this.ticker.start(() => void this.check(), intervalMs);
  }

  stopPolling(): void {
    this.ticker.stop();
  }
}
