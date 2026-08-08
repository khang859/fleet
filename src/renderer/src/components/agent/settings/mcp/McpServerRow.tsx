import { useState } from 'react';
import {
  ChevronRight,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert
} from 'lucide-react';
import type { McpServerConfig, McpServerStatus } from '../../../../../../shared/agent-mcp';
import { transportOf } from '../../../../../../shared/agent-mcp';
import { Toggle } from '../Toggle';
import { MenuItem, RowMenu } from '../RowMenu';

/**
 * One configured server, collapsed to a line until the user wants the detail.
 *
 * The line answers the two questions a server list is read for - is it working,
 * and what did it bring - and everything else is behind the disclosure. A server
 * offering forty tools is common, and a list that shows all of them by default
 * is a settings pane nobody scrolls to the bottom of.
 */

const DOT: Record<McpServerStatus['state'], string> = {
  connected: 'bg-emerald-400',
  connecting: 'bg-amber-400',
  // Not red: a server asking for a sign-in has nothing wrong with it, and a red
  // dot sends the user looking for a fault instead of clicking the button.
  'needs-auth': 'bg-sky-400',
  failed: 'bg-red-400',
  disabled: 'bg-fleet-text-subtle/50'
};

const STATE_TEXT: Record<McpServerStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  'needs-auth': 'Needs sign-in',
  failed: 'Not connected',
  disabled: 'Off'
};

export function McpServerRow({
  name,
  config,
  status,
  busy,
  signInError,
  hasCredential,
  onToggle,
  onEdit,
  onRemove,
  onReconnect,
  onSignIn,
  onSignOut,
  onToolsChange
}: {
  name: string;
  config: McpServerConfig;
  /** Absent until the manager has said anything about this server. */
  status: McpServerStatus | undefined;
  busy: boolean;
  signInError: string | undefined;
  hasCredential: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  onReconnect: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onToolsChange: (disabledTools: string[]) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const state = config.enabled ? (status?.state ?? 'connecting') : 'disabled';
  const tools = status?.tools ?? [];
  const disabled = new Set(config.disabledTools ?? []);

  const toggleTool = (tool: string, on: boolean): void => {
    const next = new Set(disabled);
    if (on) next.delete(tool);
    else next.add(tool);
    onToolsChange([...next]);
  };

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
            title={STATE_TEXT[state]}
            className={`size-2 shrink-0 rounded-full ${DOT[state]} ${state === 'connecting' ? 'animate-pulse' : ''}`}
          />
          <span className="min-w-0 truncate text-sm text-fleet-text">{name}</span>
          <span className="shrink-0 rounded border border-fleet-border-strong px-1.5 py-px text-[10px] uppercase tracking-wide text-fleet-text-subtle">
            {transportOf(config) === 'http' ? 'HTTP' : 'stdio'}
          </span>
          <span className="min-w-0 truncate text-xs text-fleet-text-muted">
            {config.enabled ? summary(status) : 'Off'}
          </span>
        </button>

        {busy && <Loader2 size={14} className="shrink-0 animate-spin text-fleet-text-subtle" />}
        <Toggle checked={config.enabled} onChange={onToggle} ariaLabel={`Enable ${name}`} />
        <RowMenu label={name}>
          {(pick) => (
            <>
              <MenuItem icon={<Pencil size={13} />} onClick={pick(onEdit)}>
                Edit…
              </MenuItem>
              <MenuItem icon={<RefreshCw size={13} />} onClick={pick(onReconnect)}>
                Reconnect
              </MenuItem>
              {hasCredential && (
                <MenuItem icon={<KeyRound size={13} />} onClick={pick(onSignOut)}>
                  Sign out
                </MenuItem>
              )}
              <MenuItem icon={<Trash2 size={13} />} danger onClick={pick(onRemove)}>
                Remove
              </MenuItem>
            </>
          )}
        </RowMenu>
      </div>

      {open && (
        <div className="space-y-3 border-t border-fleet-border px-3 py-3 duration-150 animate-in fade-in slide-in-from-top-1">
          <p className="truncate text-xs text-fleet-text-subtle" title={endpoint(config)}>
            {endpoint(config)}
          </p>

          {state === 'needs-auth' && (
            <Notice tone="info">
              <span className="flex-1">This server wants you to sign in.</span>
              <button
                type="button"
                onClick={onSignIn}
                disabled={busy}
                className="shrink-0 rounded-md fleet-accent-bg px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 focus-ring-offset"
              >
                <KeyRound size={12} className="-mt-px mr-1 inline" />
                Sign in
              </button>
            </Notice>
          )}

          {signInError !== undefined && <Notice tone="warn">{signInError}</Notice>}
          {state === 'failed' && status?.error !== undefined && (
            <Notice tone="warn">{status.error}</Notice>
          )}

          {tools.length === 0 ? (
            <p className="text-xs text-fleet-text-muted">
              {state === 'connected' ? 'This server offers no tools.' : 'No tools yet.'}
            </p>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-fleet-text-subtle">
                Tools
              </p>
              {tools.map((tool) => (
                <label
                  key={tool.name}
                  className="flex cursor-pointer items-start gap-2.5 rounded px-1 py-1 transition-colors hover:bg-fleet-surface-3/60"
                >
                  <input
                    type="checkbox"
                    checked={!disabled.has(tool.name)}
                    onChange={(e) => toggleTool(tool.name, e.target.checked)}
                    className="mt-0.5 size-3.5 shrink-0 fleet-accent-input focus-ring"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-fleet-text">{tool.name}</span>
                    {tool.description !== undefined && tool.description !== '' && (
                      <span className="block truncate text-[11px] text-fleet-text-subtle">
                        {tool.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What the server brought, or why it did not. */
function summary(status: McpServerStatus | undefined): string {
  if (status === undefined) return 'Connecting…';
  if (status.state === 'connected') {
    return status.toolCount === 1 ? '1 tool' : `${status.toolCount} tools`;
  }
  return STATE_TEXT[status.state];
}

/** The thing this server actually is: a URL, or a command line. */
function endpoint(config: McpServerConfig): string {
  if (config.url !== undefined && config.url !== '') return config.url;
  return [config.command ?? '', ...(config.args ?? [])].join(' ').trim();
}

function Notice({
  tone,
  children
}: {
  tone: 'info' | 'warn';
  children: React.ReactNode;
}): React.JSX.Element {
  const look =
    tone === 'info'
      ? 'border-sky-500/25 bg-sky-500/10 text-sky-200'
      : 'border-amber-500/25 bg-amber-500/10 text-amber-200';
  return (
    <div className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs ${look}`}>
      {tone === 'warn' && <TriangleAlert size={13} className="shrink-0" />}
      {children}
    </div>
  );
}
