import { Columns2, Rows2, Search, X, GitBranch, FileSearch, Clipboard, BookOpen } from 'lucide-react';
import { formatShortcut, getShortcut } from '../lib/shortcuts';

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
  onInjectSkills
}: PaneToolbarProps): React.JSX.Element {
  return (
    <div
      className={`absolute top-2 right-2 z-20 transition-opacity flex items-center gap-0.5 bg-neutral-800/80 backdrop-blur-sm rounded-md border border-neutral-700/50 p-0.5 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSplitHorizontal();
        }}
        className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
        title={`Split Right (${formatShortcut(getShortcut('split-right')!)})`}
      >
        <Columns2 size={14} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSplitVertical();
        }}
        className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
        title={`Split Down (${formatShortcut(getShortcut('split-down')!)})`}
      >
        <Rows2 size={14} />
      </button>
      {isGitRepo && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onGitChanges();
          }}
          className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          title={`Git Changes (${formatShortcut(getShortcut('git-changes')!)})`}
        >
          <GitBranch size={14} />
        </button>
      )}
      {onFileSearch && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onFileSearch();
          }}
          className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          title={`Search files on disk (${formatShortcut(getShortcut('file-search')!)})`}
        >
          <FileSearch size={14} />
        </button>
      )}
      {onClipboardHistory && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClipboardHistory();
          }}
          className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          title={`Clipboard history (${formatShortcut(getShortcut('clipboard-history')!)})`}
        >
          <Clipboard size={14} />
        </button>
      )}
      {onInjectSkills && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onInjectSkills();
          }}
          className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          title={`Inject Fleet Skills (${formatShortcut(getShortcut('inject-skills')!)})`}
        >
          <BookOpen size={14} />
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSearch();
        }}
        className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
        title={`Search (${formatShortcut(getShortcut('search')!)})`}
      >
        <Search size={14} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
        title={`Close Pane (${formatShortcut(getShortcut('close-pane')!)})`}
      >
        <X size={14} />
      </button>
    </div>
  );
}
