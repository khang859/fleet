import { useState } from 'react';
import { Loader2, Radar } from 'lucide-react';
import type { LocalEndpointScanHit } from '../../../../../../shared/agent-endpoints';
import { hostPort } from '../../../../../../shared/agent-endpoint-url';
import { Overlay } from '../../../Overlay';

/**
 * What is already running on this machine.
 *
 * Only ever on request. An app that reaches out to a dozen ports on its own,
 * unasked, is doing something the user did not ask for and cannot see - so this
 * is a button, and the sentence above the button says exactly what pressing it
 * will do before it does it.
 *
 * Found servers are offered, never adopted: each row has its own Add. Picking
 * from a list of things you can see is the fast path, and it stays a decision.
 */
export function EndpointScanDialog({
  open,
  scanning,
  found,
  taken,
  onScan,
  onAdd,
  onClose
}: {
  open: boolean;
  scanning: boolean;
  /** The last scan's findings; `null` until one has been run. */
  found: LocalEndpointScanHit[] | null;
  /** Addresses already configured, which a scan finds again every time. */
  taken: string[];
  onScan: () => void;
  onAdd: (hit: LocalEndpointScanHit) => void;
  onClose: () => void;
}): React.JSX.Element {
  // Which rows have been added, so a list nobody re-scanned stops offering the
  // same server twice.
  const [added, setAdded] = useState<string[]>([]);

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-[480px] max-h-[min(70vh,560px)] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <Radar size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">Look for local servers</h2>
          <p className="text-xs text-fleet-text-muted">
            Fleet checks the usual ports on this machine - nothing leaves it.
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-fleet-border px-5 py-4">
        {scanning ? (
          <p className="flex items-center gap-2 py-6 text-sm text-fleet-text-muted">
            <Loader2 size={14} className="animate-spin" />
            Checking…
          </p>
        ) : found === null ? (
          <p className="py-6 text-center text-sm text-fleet-text-muted">
            Nothing checked yet. Press Check to look.
          </p>
        ) : found.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-fleet-text-secondary">Nothing found.</p>
            {/* Told what was actually tried, rather than left to conclude that
                there is nothing on the machine. The list is short by design and
                a server on any other port is invisible to it. */}
            <p className="mx-auto mt-1 max-w-xs text-xs text-fleet-text-muted">
              Only the common ports are checked. If your server is on another one, close this and
              add its address directly.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {found.map((hit) => {
              // A scan finds the servers already configured along with the new
              // ones. Offering Add on those would be a button that does
              // nothing; saying they are already there answers the question the
              // person opened this to ask.
              const done = added.includes(hit.baseUrl) || taken.includes(hit.baseUrl);
              return (
                <div
                  key={hit.baseUrl}
                  className="flex items-center gap-3 rounded-lg border border-fleet-border bg-fleet-surface-2 px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-fleet-text">
                      {hostPort(hit.baseUrl)}
                    </span>
                    <span className="block truncate text-[11px] text-fleet-text-muted">
                      {hit.fingerprint === 'llamacpp' ? 'llama.cpp · ' : ''}
                      {hit.models.map((m) => m.name).join(', ')}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={done}
                    onClick={() => {
                      setAdded((a) => [...a, hit.baseUrl]);
                      onAdd(hit);
                    }}
                    className="shrink-0 rounded-md border border-fleet-border-strong px-2.5 py-1 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-3 disabled:opacity-40 focus-ring"
                  >
                    {done ? 'Added' : 'Add'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-fleet-border px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 focus-ring"
        >
          Done
        </button>
        <button
          type="button"
          onClick={() => {
            setAdded([]);
            onScan();
          }}
          disabled={scanning}
          className="rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 active:scale-[0.98] focus-ring-offset"
        >
          {found === null ? 'Check' : 'Check again'}
        </button>
      </div>
    </Overlay>
  );
}
