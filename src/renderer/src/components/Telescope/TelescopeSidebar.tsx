// src/renderer/src/components/Telescope/TelescopeSidebar.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelRightClose, Search } from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspace-store';
import { SidebarResizeHandle } from '../SidebarResizeHandle';
import { DEFAULT_TELESCOPE_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH_RATIO } from '../sidebar-constants';
import { createBrowseMode } from './modes/browse-mode';
import { useBrowseDir } from './use-browse-dir';
import { Breadcrumbs } from './Breadcrumbs';
import type { TelescopeItem } from './types';
import type { PathContext } from '../../../../shared/shell-profiles';

type TelescopeSidebarProps = {
  /** The focused pane's directory, or undefined for a pane without one (a file viewer, say). */
  cwd: string | undefined;
  paneId: string | null;
  pathContext: PathContext | undefined;
};

/** The pane the sidebar follows: its folder, and where Shift+Enter pastes a path. */
type FollowTarget = {
  cwd: string;
  paneId: string | null;
  pathContext: PathContext | undefined;
};

/** The Telescope browser docked on the right of the window. */
export function TelescopeSidebar({
  cwd,
  paneId,
  pathContext
}: TelescopeSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const width = useWorkspaceStore(
    (s) => s.workspace.telescopeSidebarWidth ?? DEFAULT_TELESCOPE_SIDEBAR_WIDTH
  );
  const setWidth = useWorkspaceStore((s) => s.setTelescopeSidebarWidth);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleTelescopeSidebar);

  // Only a pane with a folder moves the sidebar. Opening a file from it focuses
  // the new file pane, which has none, and must not throw the view back home.
  const [target, setTarget] = useState<FollowTarget>({
    cwd: cwd ?? window.fleet.homeDir,
    paneId,
    pathContext
  });
  if (cwd && (cwd !== target.cwd || paneId !== target.paneId)) {
    setTarget({ cwd, paneId, pathContext });
  }

  const browse = useBrowseDir(target.cwd, target.pathContext);
  const mode = useMemo(() => createBrowseMode(browse, target.paneId), [browse, target.paneId]);
  const items = useMemo(() => mode.onSearch(query), [mode, query]);

  // A new folder or filter starts the selection at the top
  useEffect(() => setSelectedIndex(0), [browse.currentDir, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-result-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Clamp the width when the window shrinks below it
  useEffect(() => {
    const handleWindowResize = (): void => {
      const max = window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO;
      if (width > max) setWidth(max);
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [width, setWidth]);

  const navigate = (dir: string): void => {
    browse.navigate(dir);
    setQuery('');
  };

  const select = (item: TelescopeItem): void => {
    mode.onSelect(item);
    if (item.data?.isDirectory === true) setQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const item = items[selectedIndex] as TelescopeItem | undefined;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && item) {
      e.preventDefault();
      if (e.shiftKey) {
        mode.onAltSelect?.(item);
      } else {
        select(item);
      }
    } else if (e.key === 'Backspace' && query === '') {
      e.preventDefault();
      browse.navigateUp();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
      } else {
        e.currentTarget.blur();
      }
    }
  };

  return (
    <div
      ref={rootRef}
      // No left margin: the pane grid's own padding already supplies the 8px
      // gutter, as it does for the sidebar on the left.
      className="relative flex flex-col my-2 mr-2 rounded-lg bg-fleet-glass-chrome border border-fleet-border shadow-md shadow-black/20 shrink-0 min-h-0"
      style={{ width, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Header: filter input + close */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fleet-border">
        <Search size={14} className="text-fleet-text-subtle shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={mode.placeholder}
          aria-label="Filter current directory"
          className="flex-1 bg-transparent text-sm text-fleet-text outline-none placeholder-fleet-text-subtle min-w-0"
        />
        <button
          onClick={toggleSidebar}
          title="Close browser"
          aria-label="Close browser"
          className="text-fleet-text-subtle hover:text-fleet-text px-1 rounded hover:bg-fleet-surface-2 transition active:scale-90 shrink-0"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      <Breadcrumbs crumbs={browse.crumbs} onNavigate={navigate} />

      {/* Directory listing */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-4 text-xs text-fleet-text-subtle text-center italic">
            {browse.loading ? 'Loading...' : query ? 'No results' : 'Empty directory'}
          </div>
        ) : (
          items.map((item, i) => (
            <BrowseRow
              key={item.id}
              item={item}
              index={i}
              isSelected={i === selectedIndex}
              onClick={(e) => {
                setSelectedIndex(i);
                if (e.shiftKey) {
                  mode.onAltSelect?.(item);
                } else {
                  select(item);
                }
              }}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-fleet-border flex items-center gap-3 text-[11px] text-fleet-text-subtle">
        <span>↵ open</span>
        <span>⇧↵ paste path</span>
        <span>⌫ up dir</span>
      </div>

      <SidebarResizeHandle
        sidebarRef={rootRef}
        onResize={setWidth}
        onReset={() => setWidth(DEFAULT_TELESCOPE_SIDEBAR_WIDTH)}
        edge="left"
      />
    </div>
  );
}

type BrowseRowProps = {
  item: TelescopeItem;
  index: number;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
};

function BrowseRow({ item, index, isSelected, onClick }: BrowseRowProps): React.JSX.Element {
  const tone = isSelected
    ? 'bg-fleet-surface-3 text-fleet-text'
    : item.data?.isIgnored
      ? 'text-fleet-text-subtle hover:bg-fleet-surface-2'
      : 'text-fleet-text-secondary hover:bg-fleet-surface-2';

  return (
    <button
      data-result-index={index}
      title={item.title}
      className={`w-full flex items-center gap-2 px-3 py-1 text-sm text-left transition-colors ${tone}`}
      onClick={onClick}
    >
      <span className="shrink-0 flex items-center">{item.icon}</span>
      <span className="truncate">{item.title}</span>
    </button>
  );
}
