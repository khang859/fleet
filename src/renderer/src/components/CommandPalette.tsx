import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from './ui/command';
import { createCommandRegistry, formatCommandShortcut, type Command } from '../lib/commands';
import {
  findPaneLocation,
  paneLabel,
  selectNeedsMePaneIds,
  type PaletteItem
} from '../lib/palette-items';
import { rankIds } from '../lib/frecency';
import { useCommandFrecencyStore } from '../store/command-frecency-store';
import { useNotificationStore } from '../store/notification-store';
import { useWorkspaceStore } from '../store/workspace-store';

type CommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
};

/** Map a static Command into a PaletteItem in the 'command' section. */
function toCommandItem(cmd: Command): PaletteItem {
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
  const announcerRef = useRef<HTMLDivElement>(null);
  const record = useCommandFrecencyStore((s) => s.record);

  // Reactive subscriptions - every dep below is used inside the memo body.
  const tabs = useWorkspaceStore((s) => s.workspace.tabs);
  const activities = useNotificationStore((s) => s.activities);
  const frecencyMap = useCommandFrecencyStore((s) => s.map);

  const staticCommands = useMemo(() => createCommandRegistry(), []);

  const { needsYou, recent, commands } = useMemo(() => {
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

    const commandItems = staticCommands.map(toCommandItem);

    const byId = new Map(commandItems.map((c) => [c.id, c]));
    const recentItems = rankIds(frecencyMap, Date.now())
      .map((id) => byId.get(id))
      .filter((x): x is PaletteItem => x !== undefined)
      .slice(0, 6);

    return { needsYou: needsYouItems, recent: recentItems, commands: commandItems };
  }, [tabs, activities, frecencyMap, staticCommands]);

  useEffect(() => {
    if (isOpen) setSearch('');
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

  const runItem = (item: PaletteItem): void => {
    onClose();
    // Only static commands participate in frecency (stable ids); pane jumps do not.
    if (item.section === 'command' || item.section === 'recent') record(item.id);
    item.run();
  };

  const showRecent = search === '';

  return (
    <CommandDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label="Command palette"
      commandProps={{ loop: true }}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search agents, panes, and commands..."
        autoFocus
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

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
      </CommandList>

      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
        <span>Command palette</span>
        <span className="flex gap-3">
          <span>↵ Run</span>
          <span>esc Close</span>
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
