import { useEffect, useRef, useState } from 'react';
import { Plus, Radar } from 'lucide-react';
import type {
  LocalEndpointConfig,
  LocalEndpointScanHit
} from '../../../../../../shared/agent-endpoints';
import { FieldGroup } from '../primitives';
import { statusOf, useAgentEndpointsStore } from '../../../../store/agent-endpoints-store';
import { EndpointRow } from './EndpointRow';
import { EndpointDialog } from './EndpointDialog';
import { EndpointScanDialog } from './EndpointScanDialog';
import { newEndpointId } from './endpoint-copy';

/**
 * Inference servers running on this machine.
 *
 * Sits between the OpenRouter key and the model pickers, which is the order the
 * decisions are actually made in: where models can come from, then which model
 * does what. Both of the sources above it are optional on their own - a user
 * with only a `llama-server` never needs a key, and one with only a key never
 * needs this - and the panel reads that way rather than treating either as the
 * real one.
 */
export function LocalEndpointsSection({
  endpoints,
  onChange
}: {
  endpoints: LocalEndpointConfig[];
  onChange: (next: LocalEndpointConfig[]) => void;
}): React.JSX.Element {
  const { statuses, busy, scanning, found } = useAgentEndpointsStore();
  const store = useAgentEndpointsStore;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  /**
   * The list as this section last left it, while settings catch up.
   *
   * A settings write is two IPC round trips, so `endpoints` still holds the old
   * list for the whole of that trip. Composing the next change against the prop
   * would mean a second change made before the first came back silently undid
   * it - and adding both servers a scan found, one after the other, is the
   * ordinary way this screen is used rather than a race worth engineering
   * around. Dropped as soon as the prop matches, so an edit from anywhere else
   * is still adopted.
   */
  const pending = useRef<LocalEndpointConfig[] | null>(null);
  if (pending.current !== null && JSON.stringify(pending.current) === JSON.stringify(endpoints)) {
    pending.current = null;
  }
  const list = pending.current ?? endpoints;

  /**
   * The same list, read at the moment of a change rather than at the render the
   * handler was drawn in. Two Adds clicked before React has redrawn anything
   * share one render's closure, so a captured `list` would be the same stale
   * array in both.
   */
  const current = (): LocalEndpointConfig[] => pending.current ?? endpoints;

  // Asked as the pane opens, so a row is never sitting on the answer from
  // whenever the app last happened to look.
  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  const editingEndpoint = list.find((e) => e.id === editing) ?? null;

  const apply = (next: LocalEndpointConfig[]): void => {
    pending.current = next;
    onChange(next);
  };

  const save = (endpoint: LocalEndpointConfig): void => {
    const base = current();
    const exists = base.some((e) => e.id === endpoint.id);
    apply(exists ? base.map((e) => (e.id === endpoint.id ? endpoint : e)) : [...base, endpoint]);
    setAdding(false);
    setEditing(null);
    // Asked about straight away rather than on the next visit: somebody who has
    // just typed an address wants to know whether it was the right one.
    void (async (): Promise<void> => {
      await store.getState().refresh();
      await store.getState().refresh(endpoint.id);
    })();
  };

  const patch = (endpoint: LocalEndpointConfig, change: Partial<LocalEndpointConfig>): void => {
    apply(current().map((e) => (e.id === endpoint.id ? { ...e, ...change } : e)));
  };

  const remove = (endpoint: LocalEndpointConfig): void => {
    apply(current().filter((e) => e.id !== endpoint.id));
    void store.getState().refresh();
  };

  /** A server the scan found, taken as it was found - nothing left to fill in. */
  const addFound = (hit: LocalEndpointScanHit): void => {
    if (current().some((e) => e.baseUrl === hit.baseUrl)) return;
    save({
      id: newEndpointId(),
      baseUrl: hit.baseUrl,
      name: null,
      enabled: true,
      lastKnownModels: hit.models.map((m) => ({ wireId: m.wireId, name: m.name }))
    });
  };

  return (
    <FieldGroup title="Local models">
      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-fleet-border-strong px-4 py-6 text-center">
          <p className="text-sm text-fleet-text-secondary">No local servers.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-fleet-text-muted">
            Point Fleet at a llama.cpp, Ollama, LM Studio or vLLM server on this machine and every
            model it serves joins the pickers below. A plain llama-server serves one, so a second
            model there means a second address.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((endpoint) => (
            <EndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              status={statusOf(statuses, endpoint.id)}
              busy={busy[endpoint.id] === true}
              onToggle={(enabled) => {
                patch(endpoint, { enabled });
                if (enabled) void store.getState().refresh(endpoint.id);
              }}
              onEdit={() => setEditing(endpoint.id)}
              onRemove={() => remove(endpoint)}
              onRecheck={() => void store.getState().refresh(endpoint.id)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-md border border-fleet-border-strong px-2.5 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
        >
          <Plus size={13} />
          Add server
        </button>
        <button
          type="button"
          onClick={() => setScanOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-fleet-border-strong px-2.5 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
        >
          <Radar size={13} />
          Look for servers
        </button>
      </div>

      <EndpointDialog
        open={adding || editingEndpoint !== null}
        editing={editingEndpoint}
        takenUrls={list.map((e) => e.baseUrl)}
        onCancel={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSave={save}
      />

      <EndpointScanDialog
        open={scanOpen}
        scanning={scanning}
        found={found}
        taken={list.map((e) => e.baseUrl)}
        onScan={() => void store.getState().scan()}
        onAdd={addFound}
        onClose={() => {
          setScanOpen(false);
          store.getState().clearScan();
        }}
      />
    </FieldGroup>
  );
}
