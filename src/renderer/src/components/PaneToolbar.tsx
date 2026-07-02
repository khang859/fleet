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
  Telescope,
  FolderSync,
  FilePenLine
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { formatShortcut, getShortcut } from '../lib/shortcuts';
import { tooltipAnim } from '../lib/motion';

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
  'p-1.5 text-fleet-text-muted hover:text-fleet-text rounded hover:bg-fleet-surface-3 transition active:scale-90 focus-ring';

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
  onInjectSkills?: () => void;
  onAnnotate?: () => void;
  onTelescope?: () => void;
  onEnvSync?: () => void;
  onEnvEditor?: () => void;
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
  onTelescope,
  onEnvSync,
  onEnvEditor
}: PaneToolbarProps): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        className={`absolute top-2 right-2 z-20 transition-opacity flex items-center gap-0.5 bg-fleet-surface-2/80 backdrop-blur-sm rounded-md border border-fleet-border/50 p-0.5 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        {onSplitHorizontal && (
          <ToolbarTooltip label={`Split Right (${shortcutLabel('split-right')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSplitHorizontal();
              }}
              className={BUTTON_CLASS}
              aria-label="Split right"
            >
              <Columns2 size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onSplitVertical && (
          <ToolbarTooltip label={`Split Down (${shortcutLabel('split-down')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSplitVertical();
              }}
              className={BUTTON_CLASS}
              aria-label="Split down"
            >
              <Rows2 size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {isGitRepo && (
          <ToolbarTooltip label={`Git Changes (${shortcutLabel('git-changes')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onGitChanges();
              }}
              className={BUTTON_CLASS}
              aria-label="Git changes"
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
              className={BUTTON_CLASS}
              aria-label="Search files"
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
              className={BUTTON_CLASS}
              aria-label="Clipboard history"
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
              className={BUTTON_CLASS}
              aria-label="Inject Fleet skills"
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
              className={BUTTON_CLASS}
              aria-label="Annotate webpage"
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
              className={BUTTON_CLASS}
              aria-label="Telescope"
            >
              <Telescope size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onEnvSync && (
          <ToolbarTooltip label="Env Sync">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEnvSync();
              }}
              className={BUTTON_CLASS}
              aria-label="Env sync"
            >
              <FolderSync size={14} />
            </button>
          </ToolbarTooltip>
        )}
        {onEnvEditor && (
          <ToolbarTooltip label="Edit .env">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEnvEditor();
              }}
              className={`${BUTTON_CLASS.replace('transition ', 'transition-colors ')}`}
              aria-label="Edit .env"
            >
              <FilePenLine size={14} />
            </button>
          </ToolbarTooltip>
        )}
        <ToolbarTooltip label={`Search in Pane (${shortcutLabel('search')})`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSearch();
            }}
            className={BUTTON_CLASS}
            aria-label="Search in pane"
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
            className={BUTTON_CLASS}
            aria-label="Close pane"
          >
            <X size={14} />
          </button>
        </ToolbarTooltip>
      </div>
    </Tooltip.Provider>
  );
}
