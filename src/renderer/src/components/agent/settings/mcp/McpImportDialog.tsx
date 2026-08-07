import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { McpDetectedServer } from '../../../../../../shared/agent-mcp';
import { transportOf } from '../../../../../../shared/agent-mcp';
import { Overlay } from '../../../Overlay';
import { shortenPath } from '../../../../lib/shorten-path';

/**
 * The servers other tools already have, offered as a list to tick.
 *
 * Grouped by the file they came from rather than flattened, because "which of
 * these do I want" is answered differently for a config that belongs to this
 * project than for one that follows the user everywhere - and because two tools
 * both having a `context7` is common, and the only thing telling them apart is
 * where they came from.
 */

const SOURCE_LABEL: Record<McpDetectedServer['origin']['source'], string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode'
};

/** One config file's worth of findings. */
type Group = {
  key: string;
  label: string;
  path: string;
  found: McpDetectedServer[];
};

export function McpImportDialog({
  open,
  detected,
  scanning,
  onCancel,
  onImport
}: {
  open: boolean;
  detected: McpDetectedServer[];
  scanning: boolean;
  onCancel: () => void;
  onImport: (picked: Array<{ name: string; path: string }>) => void;
}): React.JSX.Element {
  // Keyed by source name and path, which is what the import call takes and what
  // makes two servers with the same name from different files distinct.
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupByFile(detected), [detected]);

  // Everything not already imported starts ticked: the common case is "yes, all
  // of them", and the user who wants three of eight can untick five faster than
  // they can tick three.
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(detected.filter((d) => d.status !== 'known').map(keyOf)));
  }, [open, detected]);

  const toggle = (key: string): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setGroup = (group: Group, on: boolean): void => {
    setPicked((current) => {
      const next = new Set(current);
      for (const found of group.found) {
        if (on) next.add(keyOf(found));
        else next.delete(keyOf(found));
      }
      return next;
    });
  };

  const chosen = detected.filter((d) => picked.has(keyOf(d)));

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      panelClassName="w-[600px] h-[min(70vh,560px)] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <Download size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">Import MCP servers</h2>
          <p className="text-xs text-fleet-text-muted">
            Fleet keeps its own copy, so editing one here changes nothing over there.
          </p>
        </div>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto border-t border-fleet-border">
        {scanning ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-fleet-text-muted">
            <Loader2 size={15} className="animate-spin" />
            Looking for servers…
          </div>
        ) : groups.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-fleet-text-muted">
              No servers found in Claude Code or OpenCode.
            </p>
            <p className="mt-1 text-xs text-fleet-text-subtle">
              Fleet looks in their user configs and in this project&rsquo;s folder.
            </p>
          </div>
        ) : (
          groups.map((group) => {
            const allOn = group.found.every((f) => picked.has(keyOf(f)));
            return (
              <div key={group.key}>
                <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-1">
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-fleet-text-subtle">
                      {group.label}
                    </p>
                    <p
                      className="truncate text-[11px] text-fleet-text-subtle/80"
                      title={group.path}
                    >
                      {shortenPath(group.path)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGroup(group, !allOn)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
                  >
                    {allOn ? 'None' : 'All'}
                  </button>
                </div>
                {group.found.map((found) => (
                  <FoundRow
                    key={keyOf(found)}
                    found={found}
                    checked={picked.has(keyOf(found))}
                    onToggle={() => toggle(keyOf(found))}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-fleet-border px-5 py-3">
        <span className="text-[11px] text-fleet-text-subtle">
          Credentials come across too, into this device&rsquo;s keychain.
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() =>
              onImport(chosen.map((d) => ({ name: d.origin.sourceName, path: d.origin.path })))
            }
            className="rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-40 focus-ring-offset"
          >
            {chosen.length === 1 ? 'Import 1 server' : `Import ${chosen.length} servers`}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function FoundRow({
  found,
  checked,
  onToggle
}: {
  found: McpDetectedServer;
  checked: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-3 px-5 py-2 transition-colors hover:bg-fleet-surface-2/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3.5 shrink-0 fleet-accent-input focus-ring"
      />
      <span className="min-w-0 flex-1 truncate text-sm text-fleet-text">{found.name}</span>
      <span className="shrink-0 rounded border border-fleet-border-strong px-1.5 py-px text-[10px] uppercase tracking-wide text-fleet-text-subtle">
        {transportOf(found.config) === 'http' ? 'HTTP' : 'stdio'}
      </span>
      <Marker status={found.status} />
    </label>
  );
}

/**
 * Whether this one is worth a second look.
 *
 * `known` gets no marker at all: it is the majority on every re-scan, and a
 * badge that appears on nearly every row stops being read.
 */
function Marker({ status }: { status: McpDetectedServer['status'] }): React.JSX.Element | null {
  if (status === 'known') {
    return (
      <span className="w-14 shrink-0 text-right text-[10px] text-fleet-text-subtle">have</span>
    );
  }
  const look =
    status === 'new'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return (
    <span
      className={`w-14 shrink-0 rounded border px-1.5 py-px text-center text-[10px] font-medium ${look}`}
    >
      {status}
    </span>
  );
}

/** One row's identity: the name in its own file, plus that file. */
function keyOf(found: McpDetectedServer): string {
  return `${found.origin.path}::${found.origin.sourceName}`;
}

function groupByFile(detected: McpDetectedServer[]): Group[] {
  const groups = new Map<string, Group>();
  for (const found of detected) {
    const { source, scope, path } = found.origin;
    const existing = groups.get(path);
    if (existing === undefined) {
      groups.set(path, {
        key: path,
        label: `${SOURCE_LABEL[source]} · ${scope === 'user' ? 'all projects' : 'this project'}`,
        path,
        found: [found]
      });
    } else {
      existing.found.push(found);
    }
  }
  return [...groups.values()];
}
