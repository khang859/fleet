import { useState } from 'react';
import {
  Columns2,
  Rows2,
  Search,
  X,
  GitBranch,
  FileSearch,
  Clipboard,
  Crosshair,
  Telescope,
  NotebookPen,
  FolderSync,
  FilePenLine,
  MoreHorizontal,
  FolderTree,
  SquareArrowOutUpRight
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Popover from '@radix-ui/react-popover';
import { formatShortcut, getShortcut } from '../lib/shortcuts';
import { tooltipAnim, popperAnim } from '../lib/motion';

function shortcutLabel(id: string): string {
  const def = getShortcut(id);
  return def ? formatShortcut(def) : id;
}

function ToolbarTooltip({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={6}
          className={`px-2 py-1 text-xs text-fleet-text bg-fleet-surface-2 border border-fleet-border rounded shadow-lg z-50 ${tooltipAnim}`}
        >
          {label}
          <Tooltip.Arrow className="fill-fleet-surface-2" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const BUTTON_CLASS =
  'p-1 text-fleet-text-subtle hover:text-fleet-text rounded hover:bg-fleet-surface-3 transition active:scale-90 focus-ring';

// Destructive action: telegraph danger on hover so a mis-click near Search
// reads as risky before it happens.
const CLOSE_BUTTON_CLASS =
  'p-1 text-fleet-text-subtle hover:text-red-400 rounded hover:bg-red-500/10 transition active:scale-90 focus-ring';

function ToolbarButton({
  label,
  ariaLabel,
  icon,
  onClick
}: {
  label: string;
  ariaLabel: string;
  icon: React.ReactNode;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <ToolbarTooltip label={label}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={BUTTON_CLASS}
        aria-label={ariaLabel}
      >
        {icon}
      </button>
    </ToolbarTooltip>
  );
}

function MenuItem({
  icon,
  label,
  shortcut,
  onSelect
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-3 hover:text-fleet-text"
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="shrink-0 text-fleet-text-subtle">{shortcut}</span>}
    </button>
  );
}

const MOVE_LABEL = 'Move to New Tab';

/** Agent and viewer panes have no toolbar, so this one action floats in their corner. */
export function MovePaneButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="absolute top-1 right-1 z-10 rounded bg-fleet-surface-2/80 opacity-0 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100">
        <ToolbarButton
          label={MOVE_LABEL}
          ariaLabel="Move pane to new tab"
          icon={<SquareArrowOutUpRight size={14} />}
          onClick={onClick}
        />
      </div>
    </Tooltip.Provider>
  );
}

type PaneToolbarProps = {
  visible: boolean;
  isGitRepo: boolean;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose: () => void;
  onSearch: () => void;
  onGitChanges: () => void;
  onFileSearch?: () => void;
  onClipboardHistory?: () => void;
  onAnnotate?: () => void;
  onTelescope?: () => void;
  onTelescopeSidebar?: () => void;
  onNotes?: () => void;
  onEnvSync?: () => void;
  onEnvEditor?: () => void;
  onMoveToTab?: () => void;
};

export function PaneToolbar({
  visible,
  isGitRepo,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  onSearch,
  onGitChanges,
  onFileSearch,
  onClipboardHistory,
  onAnnotate,
  onTelescope,
  onTelescopeSidebar,
  onNotes,
  onEnvSync,
  onEnvEditor,
  onMoveToTab
}: PaneToolbarProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const pick =
    (run: () => void): (() => void) =>
    () => {
      setMenuOpen(false);
      run();
    };

  // Everything that is about the pane's *contents* rather than its *shape*.
  // These used to sit in the row as eight more icons, which made the toolbar
  // wider than the title it shares a line with.
  const menuActions = [
    onMoveToTab && {
      icon: <SquareArrowOutUpRight size={14} />,
      label: MOVE_LABEL,
      onSelect: onMoveToTab
    },
    isGitRepo && {
      icon: <GitBranch size={14} />,
      label: 'Git Changes',
      shortcut: shortcutLabel('git-changes'),
      onSelect: onGitChanges
    },
    onFileSearch && {
      icon: <FileSearch size={14} />,
      label: 'Search Files',
      shortcut: shortcutLabel('file-search'),
      onSelect: onFileSearch
    },
    onClipboardHistory && {
      icon: <Clipboard size={14} />,
      label: 'Clipboard History',
      shortcut: shortcutLabel('clipboard-history'),
      onSelect: onClipboardHistory
    },
    onTelescope && {
      icon: <Telescope size={14} />,
      label: 'Telescope',
      shortcut: shortcutLabel('telescope'),
      onSelect: onTelescope
    },
    onAnnotate && {
      icon: <Crosshair size={14} />,
      label: 'Annotate webpage',
      onSelect: onAnnotate
    },
    onNotes && { icon: <NotebookPen size={14} />, label: 'Project Notes', onSelect: onNotes },
    onEnvSync && { icon: <FolderSync size={14} />, label: 'Env Sync', onSelect: onEnvSync },
    onEnvEditor && { icon: <FilePenLine size={14} />, label: 'Edit .env', onSelect: onEnvEditor }
  ].filter((a) => a !== false && a !== undefined);

  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        // Kept mounted but out of the layout when hidden: as a flex sibling of
        // the title it would otherwise reserve its full width at all times,
        // squeezing the path down to nothing and - worse - covering the part of
        // the bar you double-click to rename.
        className={`shrink-0 transition-opacity flex items-center gap-0.5 ${visible || menuOpen ? 'opacity-100' : 'hidden'}`}
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        {onSplitHorizontal && (
          <ToolbarButton
            label={`Split Right (${shortcutLabel('split-right')})`}
            ariaLabel="Split right"
            icon={<Columns2 size={14} />}
            onClick={onSplitHorizontal}
          />
        )}
        {onSplitVertical && (
          <ToolbarButton
            label={`Split Down (${shortcutLabel('split-down')})`}
            ariaLabel="Split down"
            icon={<Rows2 size={14} />}
            onClick={onSplitVertical}
          />
        )}
        <ToolbarButton
          label={`Search in Pane (${shortcutLabel('search')})`}
          ariaLabel="Search in pane"
          icon={<Search size={14} />}
          onClick={onSearch}
        />
        {onTelescopeSidebar && (
          <ToolbarButton
            label={`Telescope Browser (${shortcutLabel('telescope-sidebar')})`}
            ariaLabel="Toggle Telescope browser"
            icon={<FolderTree size={14} />}
            onClick={onTelescopeSidebar}
          />
        )}
        {menuActions.length > 0 && (
          <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <ToolbarTooltip label="More actions">
              <Popover.Trigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className={BUTTON_CLASS}
                  aria-label="More pane actions"
                >
                  <MoreHorizontal size={14} />
                </button>
              </Popover.Trigger>
            </ToolbarTooltip>
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={4}
                onClick={(e) => e.stopPropagation()}
                className={`z-50 w-60 overflow-hidden rounded-md border border-fleet-border-strong bg-fleet-surface-2 py-1 shadow-xl ${popperAnim}`}
              >
                {menuActions.map((a) => (
                  <MenuItem
                    key={a.label}
                    icon={a.icon}
                    label={a.label}
                    shortcut={a.shortcut}
                    onSelect={pick(a.onSelect)}
                  />
                ))}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        )}
        {/* Separate the destructive Close from Search so a slightly-off click
            can't kill a running pane. */}
        <div className="mx-0.5 h-4 w-px bg-fleet-border/70" aria-hidden />
        <ToolbarTooltip label={`Close Pane (${shortcutLabel('close-pane')})`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={CLOSE_BUTTON_CLASS}
            aria-label="Close pane"
          >
            <X size={14} />
          </button>
        </ToolbarTooltip>
      </div>
    </Tooltip.Provider>
  );
}
