import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, Search } from 'lucide-react';
import { YOU_LAYER } from '../../../../shared/agency-client-file';
import type { AgencyProjectSummary } from '../../../../shared/agency-projects';
import { popperAnim } from '../../lib/motion';
import { shortenPath } from '../../lib/shorten-path';
import { matches } from './layer-search';

const TAB =
  'flex min-w-0 items-center gap-1 rounded px-2.5 py-1 text-sm transition-colors focus-ring';
const ON = 'bg-fleet-surface-3 font-medium text-fleet-text';
const OFF = 'text-fleet-text-muted hover:bg-fleet-surface-3/60 hover:text-fleet-text';

/** Each row's height, and how many show before the list scrolls. */
const ROW_PX = 32;
const ROWS = 10;

/**
 * Whose preferences to show: the You layer, or one project's. Projects are
 * picked from a searchable list, by name or folder, so the row stays two tabs
 * however many projects there are, and two with the same name stay apart.
 */
export function LayerPicker(props: {
  projects: AgencyProjectSummary[];
  layer: string;
  onLayer: (layer: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const you = props.layer === YOU_LAYER;
  const current = props.projects.find((p) => p.repo.repoId === props.layer) ?? null;
  return (
    <div role="tablist" aria-label="Whose preferences" className="flex min-w-0 gap-1">
      <button
        type="button"
        role="tab"
        aria-selected={you}
        onClick={() => props.onLayer(YOU_LAYER)}
        className={`${TAB} shrink-0 ${you ? ON : OFF}`}
      >
        You · every project
      </button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            role="tab"
            aria-selected={!you}
            aria-haspopup="listbox"
            title={current?.repo.root}
            className={`${TAB} ${you ? OFF : ON}`}
          >
            <span className="truncate">{current?.repo.name ?? 'A project'}</span>
            <ChevronDown size={13} aria-hidden className="shrink-0" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className={`z-50 w-[380px] max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-fleet-border-strong bg-fleet-surface shadow-xl ${popperAnim}`}
          >
            <ProjectSearch
              projects={props.projects}
              layer={props.layer}
              onPick={(repoId) => {
                setOpen(false);
                props.onLayer(repoId);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** The project list: sorted by name, searched by name or folder, the current one ticked. */
function ProjectSearch(props: {
  projects: AgencyProjectSummary[];
  layer: string;
  onPick: (repoId: string) => void;
}): React.JSX.Element {
  const sorted = [...props.projects].sort(
    (a, b) => a.repo.name.localeCompare(b.repo.name) || a.repo.root.localeCompare(b.repo.root)
  );
  return (
    <Command label="Projects" loop defaultValue={props.layer} filter={matches}>
      <div className="flex items-center gap-2 border-b border-fleet-border px-3">
        <Search size={14} aria-hidden className="shrink-0 text-fleet-text-subtle" />
        <Command.Input
          autoFocus
          placeholder={`Find one of ${props.projects.length} projects`}
          className="h-10 w-full bg-transparent text-sm text-fleet-text outline-none placeholder:text-fleet-text-subtle"
        />
      </div>
      {/* One height while searching, so the popover never flips side as rows go. */}
      <Command.List
        style={{ height: Math.min(Math.max(props.projects.length, 2), ROWS) * ROW_PX + 12 }}
        className="overflow-y-auto p-1.5"
      >
        <Command.Empty className="py-6 text-center text-xs text-fleet-text-subtle">
          No project matches.
        </Command.Empty>
        {sorted.map((p) => (
          <Command.Item
            key={p.repo.repoId}
            value={p.repo.repoId}
            keywords={[p.repo.name, p.repo.root]}
            onSelect={() => props.onPick(p.repo.repoId)}
            style={{ height: ROW_PX }}
            className="flex cursor-pointer items-center gap-3 rounded-md px-2 outline-none data-[selected=true]:bg-fleet-surface-2"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-fleet-text">
              {p.repo.name}
            </span>
            <span
              title={p.repo.root}
              className="max-w-[55%] shrink-0 truncate font-mono text-[11px] text-fleet-text-subtle"
            >
              {shortenPath(p.repo.root)}
            </span>
            <Check
              size={13}
              aria-hidden
              className={`shrink-0 text-blue-500 ${p.repo.repoId === props.layer ? '' : 'invisible'}`}
            />
          </Command.Item>
        ))}
      </Command.List>
    </Command>
  );
}
