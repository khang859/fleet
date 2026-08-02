import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronRight, Server } from 'lucide-react';
import { popperAnim } from '../../lib/motion';
import { toCrumbs } from './remote-path-crumbs';

/** Beyond this many crumbs the middle collapses behind a "…" menu. */
const MAX_VISIBLE = 4;

type Props = {
  hostLabel: string;
  path: string;
  connected: boolean;
  onNavigate: (path: string) => void;
};

export function RemoteBreadcrumbs({
  hostLabel,
  path,
  connected,
  onNavigate
}: Props): React.JSX.Element {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const crumbs = toCrumbs(path);

  // Keep the root and the deepest few: those are the two ends users actually
  // aim for. Everything between them goes behind the overflow menu.
  const collapsed = crumbs.length > MAX_VISIBLE + 1;
  const hidden = collapsed ? crumbs.slice(1, crumbs.length - MAX_VISIBLE) : [];
  const visible = collapsed ? [crumbs[0], ...crumbs.slice(crumbs.length - MAX_VISIBLE)] : crumbs;

  return (
    <nav
      aria-label="Remote path"
      className="flex items-center gap-0.5 min-w-0 text-xs text-neutral-400"
    >
      <span
        className="flex items-center gap-1.5 pr-1.5 text-neutral-300 shrink-0"
        title={connected ? `Connected to ${hostLabel}` : `Not connected to ${hostLabel}`}
      >
        <Server size={12} />
        <span className="font-medium truncate max-w-[10rem]">{hostLabel}</span>
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            connected ? 'bg-emerald-500' : 'bg-neutral-600'
          }`}
          aria-hidden
        />
      </span>

      {visible.map((crumb, i) => {
        const isLast = i === visible.length - 1;
        // The "…" sits where the collapsed run was cut out: after the root.
        const showOverflow = collapsed && i === 1;
        return (
          <span key={crumb.path} className="flex items-center min-w-0">
            <ChevronRight size={12} className="text-neutral-600 shrink-0" />
            {showOverflow && (
              <>
                <Popover.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
                  <Popover.Trigger asChild>
                    <button
                      className="px-1 rounded hover:bg-white/10 hover:text-neutral-200 transition-colors"
                      aria-label="Show hidden path segments"
                    >
                      …
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      align="start"
                      sideOffset={4}
                      className={`min-w-[160px] max-h-64 overflow-y-auto bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-xs text-fleet-text z-50 ${popperAnim}`}
                    >
                      {hidden.map((h) => (
                        <button
                          key={h.path}
                          className="w-full text-left px-2 py-1.5 rounded hover:bg-fleet-surface-3 truncate"
                          onClick={() => {
                            setOverflowOpen(false);
                            onNavigate(h.path);
                          }}
                        >
                          {h.label}
                        </button>
                      ))}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
                <ChevronRight size={12} className="text-neutral-600 shrink-0" />
              </>
            )}
            {isLast ? (
              <span
                aria-current="page"
                className="px-1 text-neutral-200 font-medium truncate"
                title={crumb.path}
              >
                {crumb.label}
              </span>
            ) : (
              <button
                className="px-1 rounded hover:bg-white/10 hover:text-neutral-200 transition-colors truncate max-w-[9rem]"
                onClick={() => onNavigate(crumb.path)}
                title={crumb.path}
              >
                {crumb.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
