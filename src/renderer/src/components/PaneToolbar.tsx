import {
  Columns2,
  Rows2,
  Search,
  X,
  GitBranch,
  FileSearch,
  Clipboard,
  BookOpen,
  Crosshair,
  Telescope
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { formatShortcut, getShortcut } from '../lib/shortcuts';

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
          className="px-2 py-1 text-xs text-white bg-neutral-800 border border-neutral-700 rounded shadow-lg z-50"
        >
          {label}
          <Tooltip.Arrow className="fill-neutral-800" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

type PaneToolbarProps = {
  visible: boolean;
  isGitRepo: boolean;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  onSearch: () => void;
  onGitChanges: () => void;
  onFileSearch?: () => void;
  onClipboardHistory?: () => void;
  onInjectSkills?: () => void;
  onAnnotate?: () => void;
  onTelescope?: () => void;
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
  onInjectSkills,
  onAnnotate,
  onTelescope
}: PaneToolbarProps): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        className={`absolute top-2 right-2 z-20 transition-opacity flex items-center gap-0.5 bg-neutral-800/80 backdrop-blur-sm rounded-md border border-neutral-700/50 p-0.5 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <ToolbarTooltip label={`Split Right (${shortcutLabel('split-right')})`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSplitHorizontal();
            }}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          >
            <Columns2 size={14} />
          </button>
        </ToolbarTooltip>
        <ToolbarTooltip label={`Split Down (${shortcutLabel('split-down')})`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSplitVertical();
            }}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          >
            <Rows2 size={14} />
          </button>
        </ToolbarTooltip>
        {isGitRepo && (
          <ToolbarTooltip label={`Git Changes (${shortcutLabel('git-changes')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onGitChanges();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <GitBranch size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onFileSearch && (
          <ToolbarTooltip label={`Search Files (${shortcutLabel('file-search')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileSearch();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <FileSearch size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onClipboardHistory && (
          <ToolbarTooltip label={`Clipboard History (${shortcutLabel('clipboard-history')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClipboardHistory();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <Clipboard size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onInjectSkills && (
          <ToolbarTooltip label={`Inject Fleet Skills (${shortcutLabel('inject-skills')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInjectSkills();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <BookOpen size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onAnnotate && (
          <ToolbarTooltip label="Annotate webpage">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAnnotate();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <Crosshair size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onTelescope && (
          <ToolbarTooltip label={`Telescope (${shortcutLabel('telescope')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTelescope();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <Telescope size={14} />
            </button>
          </ToolbarTooltip>
        )}
        <ToolbarTooltip label={`Search in Pane (${shortcutLabel('search')})`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSearch();
            }}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          >
            <Search size={14} />
          </button>
        </ToolbarTooltip>
        <ToolbarTooltip label={`Close Pane (${shortcutLabel('close-pane')})`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          >
            <X size={14} />
          </button>
        </ToolbarTooltip>
      </div>
    </Tooltip.Provider>
  );
}
