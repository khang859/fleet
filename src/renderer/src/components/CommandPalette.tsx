import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from './ui/command';
import {
  createCommandRegistry,
  formatCommandShortcut,
  type Command as CommandDef
} from '../lib/commands';
import {
  findPaneLocation,
  paneLabel,
  selectNeedsMePaneIds,
  type PaletteItem
} from '../lib/palette-items';
import { rankIds } from '../lib/frecency';
import { useCommandFrecencyStore } from '../store/command-frecency-store';
import { useNotificationStore } from '../store/notification-store';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';

type CommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
};

/** Map a static Command into a PaletteItem in the 'command' section. */
function toCommandItem(cmd: CommandDef): PaletteItem {
  return {
    id: cmd.id,
    label: cmd.label,
    section: 'command',
    keywords: [cmd.category, ...(cmd.keywords ?? [])],
    shortcutLabel: formatCommandShortcut(cmd),
    run: cmd.execute
  };
}

function ItemRow({
  item,
  onRun
}: {
  item: PaletteItem;
  onRun: (item: PaletteItem) => void;
}): React.JSX.Element {
  return (
    <CommandItem
      value={`${item.section}:${item.id}`}
      keywords={item.keywords}
      onSelect={() => onRun(item)}
    >
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && (
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
          {item.badge}
        </span>
      )}
      {item.hasActions && !item.badge && <span className="text-[10px] text-neutral-600">⌘K</span>}
      {item.shortcutLabel && (
        <kbd className="ml-2 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
          {item.shortcutLabel}
        </kbd>
      )}
    </CommandItem>
  );
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [scopePaneId, setScopePaneId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState('');
  const announcerRef = useRef<HTMLDivElement>(null);
  const record = useCommandFrecencyStore((s) => s.record);

  // Reactive subscriptions - every dep below is used inside the memo body.
  const tabs = useWorkspaceStore((s) => s.workspace.tabs);
  const activities = useNotificationStore((s) => s.activities);
  const frecencyMap = useCommandFrecencyStore((s) => s.map);

  const staticCommands = useMemo(() => createCommandRegistry(), []);

  const { needsYou, recent, commands, destinations } = useMemo(() => {
    const needsYouItems: PaletteItem[] = selectNeedsMePaneIds(activities)
      .map((paneId) => {
        const loc = findPaneLocation(tabs, paneId);
        if (!loc) return null;
        const item: PaletteItem = {
          id: `pane:${paneId}`,
          label: paneLabel(loc),
          section: 'needs-you',
          badge: 'needs you',
          keywords: [loc.tab.label, 'agent', 'needs input'],
          run: () => {
            const ws = useWorkspaceStore.getState();
            ws.setActiveTab(loc.tabId);
            ws.setActivePane(paneId);
          }
        };
        return item;
      })
      .filter((x): x is PaletteItem => x !== null);

    // Collect bare pane ids already shown in needsYou to deduplicate destinations.
    const needsYouPaneIds = new Set(needsYouItems.map((item) => item.id.slice(5)));

    // One destination per pane across all tabs, skipping panes already in needsYou.
    const destinationItems: PaletteItem[] = tabs.flatMap((tab) =>
      collectPaneIds(tab.splitRoot)
        .filter((paneId) => !needsYouPaneIds.has(paneId))
        .map((paneId) => {
          const loc = findPaneLocation(tabs, paneId);
          if (!loc) return null;
          const item: PaletteItem = {
            id: paneId,
            label: paneLabel(loc),
            section: 'destination',
            hasActions: true,
            keywords: [loc.tab.label, 'pane', 'terminal', 'jump'],
            run: () => {
              const ws = useWorkspaceStore.getState();
              ws.setActiveTab(loc.tabId);
              ws.setActivePane(paneId);
            }
          };
          return item;
        })
        .filter((x): x is PaletteItem => x !== null)
    );

    const commandItems = staticCommands.map(toCommandItem);

    const byId = new Map(commandItems.map((c) => [c.id, c]));
    const recentItems = rankIds(frecencyMap, Date.now())
      .map((id) => byId.get(id))
      .filter((x): x is PaletteItem => x !== undefined)
      .slice(0, 6);

    return {
      needsYou: needsYouItems,
      recent: recentItems,
      commands: commandItems,
      destinations: destinationItems
    };
  }, [tabs, activities, frecencyMap, staticCommands]);

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setScopePaneId(null);
    }
  }, [isOpen]);

  // Announce result mode/counts to screen readers (cmdk ships no live region).
  useEffect(() => {
    if (!isOpen || !announcerRef.current) return;
    const t = setTimeout(() => {
      if (announcerRef.current) {
        announcerRef.current.textContent = search
          ? 'Filtering commands'
          : `${needsYou.length} agents need input`;
      }
    }, 250);
    return () => clearTimeout(t);
  }, [isOpen, search, needsYou.length]);

  const scopedActions = (paneId: string): PaletteItem[] => {
    const ws = useWorkspaceStore.getState();
    const loc = findPaneLocation(ws.workspace.tabs, paneId);
    const label = loc ? paneLabel(loc) : 'pane';
    return [
      {
        id: 'focus',
        label: `Focus ${label}`,
        section: 'command',
        run: () => {
          if (loc) {
            ws.setActiveTab(loc.tabId);
            ws.setActivePane(paneId);
          }
        }
      },
      {
        id: 'split-right',
        label: 'Split Right',
        section: 'command',
        run: () => ws.splitPane(paneId, 'horizontal')
      },
      {
        id: 'split-down',
        label: 'Split Down',
        section: 'command',
        run: () => ws.splitPane(paneId, 'vertical')
      },
      {
        id: 'rename',
        label: 'Rename Pane',
        section: 'command',
        run: () => {
          // Focus the pane first so PaneHeader is mounted and can receive the event.
          if (loc) {
            ws.setActiveTab(loc.tabId);
            ws.setActivePane(paneId);
          }
          document.dispatchEvent(
            new CustomEvent('fleet:rename-active-pane', { detail: { paneId } })
          );
        }
      },
      {
        id: 'close',
        label: 'Close Pane',
        section: 'command',
        run: () => ws.closePane(paneId)
      }
    ];
  };

  const runItem = (item: PaletteItem): void => {
    onClose();
    // Only static commands participate in frecency (stable ids); pane jumps do not.
    if (item.section === 'command' || item.section === 'recent') record(item.id);
    item.run();
  };

  const showRecent = search === '';

  // Label for the breadcrumb pill when a pane is scoped.
  const scopeLabel = scopePaneId
    ? (() => {
        const loc = findPaneLocation(tabs, scopePaneId);
        return loc ? paneLabel(loc) : 'pane';
      })()
    : '';

  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label="Command palette"
      commandProps={{
        loop: true,
        value: highlighted,
        onValueChange: setHighlighted,
        onKeyDown: (e: React.KeyboardEvent) => {
          // Enter scope: Cmd/Ctrl+K or ArrowRight on a destination row.
          if (
            scopePaneId === null &&
            ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === 'ArrowRight')
          ) {
            const parts = highlighted.split(':');
            const section = parts[0];
            const id = parts.slice(1).join(':');
            if (section === 'destination' && id) {
              e.preventDefault();
              setScopePaneId(id);
              setSearch('');
            }
            return;
          }
          // Pop scope: Esc, or Backspace on empty input.
          if (
            scopePaneId !== null &&
            (e.key === 'Escape' || (e.key === 'Backspace' && search === ''))
          ) {
            e.preventDefault();
            setScopePaneId(null);
            setSearch('');
          }
        }
      }}
    >
      {scopePaneId !== null ? (
        <div className="flex items-center border-b border-neutral-800 px-4">
          <span className="mr-2 shrink-0 rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300">
            {scopeLabel}
          </span>
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder="Search actions..."
            autoFocus
            className="h-12 w-full bg-transparent text-[15px] text-white outline-none placeholder:text-neutral-500"
          />
        </div>
      ) : (
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder="Search agents, panes, and commands..."
          autoFocus
        />
      )}
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {scopePaneId !== null ? (
          <CommandGroup heading="Actions">
            {scopedActions(scopePaneId).map((item) => (
              <ItemRow key={`scope-${item.id}`} item={item} onRun={runItem} />
            ))}
          </CommandGroup>
        ) : (
          <>
            {needsYou.length > 0 && (
              <CommandGroup heading="Needs you">
                {needsYou.map((item) => (
                  <ItemRow key={item.id} item={item} onRun={runItem} />
                ))}
              </CommandGroup>
            )}

            {showRecent && recent.length > 0 && (
              <CommandGroup heading="Recent">
                {recent.map((item) => (
                  <ItemRow
                    key={`recent-${item.id}`}
                    item={{ ...item, section: 'recent' }}
                    onRun={runItem}
                  />
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="Commands">
              {commands.map((item) => (
                <ItemRow key={item.id} item={item} onRun={runItem} />
              ))}
            </CommandGroup>

            {destinations.length > 0 && (
              <CommandGroup heading="Destinations">
                {destinations.map((item) => (
                  <ItemRow key={item.id} item={item} onRun={runItem} />
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>

      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
        <span>Command palette</span>
        <span className="flex gap-3">
          <span>↵ Run</span>
          {scopePaneId !== null ? (
            <span>esc Back</span>
          ) : (
            <>
              <span>⌘K Actions</span>
              <span>esc Close</span>
            </>
          )}
        </span>
      </div>

      <div
        ref={announcerRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
    </CommandDialog>
  );
}
