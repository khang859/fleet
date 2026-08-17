import { create } from 'zustand';
import type {
  EndpointProbeResult,
  LocalEndpointScanHit,
  LocalEndpointStatus
} from '../../../shared/agent-endpoints';
import { useAgentStore } from './agent-store';

/**
 * How the user's own inference servers are answering right now.
 *
 * Only the answering part. The endpoints themselves are settings and live with
 * the rest of `ai.agent`, so this store holds nothing that survives a quit -
 * whether a probe is in flight, what it found, what a scan turned up. Keeping
 * the two apart is what makes the row a straightforward thing to draw: the
 * config half never changes under it, and the status half is always allowed to
 * be missing.
 *
 * Separate from `agent-store` for the same reason `agent-mcp-store` is: that
 * one holds every pane's transcript and is rewritten as each token arrives, so
 * sharing it would re-render the settings pane once per token of a turn
 * happening somewhere else entirely.
 */
type AgentEndpointsState = {
  statuses: LocalEndpointStatus[];
  /** Endpoints with a probe in flight, so their row can say so. */
  busy: Record<string, boolean | undefined>;
  scanning: boolean;
  /** The last scan's findings; `null` until one has been run. */
  found: LocalEndpointScanHit[] | null;

  /** Re-ask one endpoint, or every one of them when `id` is null. */
  refresh: (id?: string | null) => Promise<void>;
  /** Ask what is at an address without saving it. The add form's Test button. */
  test: (baseUrl: string) => Promise<EndpointProbeResult>;
  scan: () => Promise<void>;
  clearScan: () => void;
};

export const useAgentEndpointsStore = create<AgentEndpointsState>((set) => ({
  statuses: [],
  busy: {},
  scanning: false,
  found: null,

  refresh: async (id = null) => {
    if (id !== null) set((s) => ({ busy: { ...s.busy, [id]: true } }));
    try {
      set({ statuses: await window.fleet.agent.endpoints.refresh(id) });
    } finally {
      if (id !== null) set((s) => ({ busy: { ...s.busy, [id]: undefined } }));
    }
  },

  test: async (baseUrl) => window.fleet.agent.endpoints.test(baseUrl),

  scan: async () => {
    set({ scanning: true });
    try {
      set({ found: await window.fleet.agent.endpoints.scan() });
    } finally {
      set({ scanning: false });
    }
  },

  clearScan: () => set({ found: null })
}));

/** The status of one endpoint, for a row that has its config but not its state. */
export function statusOf(
  statuses: LocalEndpointStatus[],
  id: string
): LocalEndpointStatus | undefined {
  return statuses.find((s) => s.id === id);
}

// Pushed whenever main learns something new about any of them, including with
// nobody asking - the probe that runs at startup finishes long before anyone
// opens this pane.
window.fleet.agent.endpoints.onStatus((statuses) => {
  useAgentEndpointsStore.setState({ statuses });
  // A server that has just answered is a set of models the pickers do not know
  // about yet. Re-read rather than re-download: the cloud half of the catalog
  // has not changed and there is no reason to fetch it again.
  void useAgentStore.getState().remergeModels();
});
