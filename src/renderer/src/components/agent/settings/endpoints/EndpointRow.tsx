import { useState } from 'react';
import { ChevronRight, Loader2, Pencil, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import type {
  LocalEndpointConfig,
  LocalEndpointStatus
} from '../../../../../../shared/agent-endpoints';
import { endpointLabel } from '../../../../../../shared/agent-endpoints';
import { hostPort as toHostPort } from '../../../../../../shared/agent-endpoint-url';
import { Toggle } from '../Toggle';
import { MenuItem, RowMenu } from '../RowMenu';
import { failureHint, statusText, statusTone, type StatusTone } from './endpoint-copy';

/**
 * One configured server, collapsed to a line until the user wants the detail.
 *
 * Built to the same shape as the MCP server rows above it, deliberately: these
 * two lists are the same kind of thing to a reader - something the user set up,
 * that may or may not be working right now - and a person who has learned to
 * read one should not have to learn the other.
 */

const DOT: Record<StatusTone, string> = {
  ok: 'bg-emerald-400',
  busy: 'bg-amber-400',
  warn: 'bg-amber-400',
  muted: 'bg-fleet-text-subtle/50'
};

export function EndpointRow({
  endpoint,
  status,
  busy,
  onToggle,
  onEdit,
  onRemove,
  onRecheck
}: {
  endpoint: LocalEndpointConfig;
  /** Absent until main has said anything about this endpoint. */
  status: LocalEndpointStatus | undefined;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  onRecheck: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const address = toHostPort(endpoint.baseUrl);
  const name = endpointLabel(endpoint, address);
  const state = endpoint.enabled ? (status?.state ?? 'unchecked') : 'disabled';
  const tone = statusTone(state);

  // The names from the last probe that succeeded, which is what the picker is
  // offering right now whether or not the server is answering.
  const models = endpoint.lastKnownModels;

  return (
    <div className="overflow-hidden rounded-lg border border-fleet-border bg-fleet-surface-2">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus-ring"
        >
          <ChevronRight
            size={14}
            className={`shrink-0 text-fleet-text-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
          <span
            className={`size-2 shrink-0 rounded-full ${DOT[tone]} ${tone === 'busy' ? 'animate-pulse' : ''}`}
          />
          <span className="min-w-0 truncate text-sm text-fleet-text">{name}</span>
          {/* The address is a badge only when it is not already the name, so an
              endpoint nobody renamed does not carry its own label twice. */}
          {name !== address && (
            <span className="shrink-0 rounded border border-fleet-border-strong px-1.5 py-px font-mono text-[10px] text-fleet-text-subtle">
              {address}
            </span>
          )}
          {status?.fingerprint === 'llamacpp' && (
            <span className="shrink-0 rounded border border-fleet-border-strong px-1.5 py-px text-[10px] uppercase tracking-wide text-fleet-text-subtle">
              llama.cpp
            </span>
          )}
          {/* Read off the config rather than off the status, so a row that has
              just been switched off says so before main has been asked. */}
          <span
            className={`min-w-0 truncate text-xs ${tone === 'warn' ? 'text-amber-400' : 'text-fleet-text-muted'}`}
          >
            {endpoint.enabled ? statusText(status) : 'Off'}
          </span>
        </button>

        {busy && <Loader2 size={14} className="shrink-0 animate-spin text-fleet-text-subtle" />}
        <Toggle checked={endpoint.enabled} onChange={onToggle} ariaLabel={`Enable ${name}`} />
        <RowMenu label={name}>
          {(pick) => (
            <>
              <MenuItem icon={<Pencil size={13} />} onClick={pick(onEdit)}>
                Edit…
              </MenuItem>
              <MenuItem icon={<RefreshCw size={13} />} onClick={pick(onRecheck)}>
                Check again
              </MenuItem>
              <MenuItem icon={<Trash2 size={13} />} danger onClick={pick(onRemove)}>
                Remove
              </MenuItem>
            </>
          )}
        </RowMenu>
      </div>

      {open && (
        <div className="space-y-3 border-t border-fleet-border px-3 py-3 duration-150 animate-in fade-in slide-in-from-top-1">
          <p className="truncate font-mono text-xs text-fleet-text-subtle">{endpoint.baseUrl}</p>

          {state === 'unreachable' && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
              <TriangleAlert size={13} className="mt-px shrink-0" />
              <span>{failureHint(status?.reason ?? null, address)}</span>
            </div>
          )}

          {models.length === 0 ? (
            <p className="text-xs text-fleet-text-muted">
              {state === 'ready' || state === 'sleeping'
                ? 'This server has no model loaded.'
                : 'Nothing seen here yet.'}
            </p>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-fleet-text-subtle">
                Models
              </p>
              {models.map((model) => (
                <p key={model.wireId} className="truncate text-xs text-fleet-text">
                  {model.name}
                </p>
              ))}
              {/*
                Said out loud rather than implied by a greyed row somewhere else.
                These models are still in every picker - that is the point of
                remembering them - and a person looking at this list deserves to
                know which half of it is currently answering.
              */}
              {state === 'unreachable' && (
                <p className="pt-0.5 text-[11px] text-fleet-text-muted">
                  Still listed while the server is down, so your choice is kept.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
