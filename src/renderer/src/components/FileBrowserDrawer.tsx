import { useCallback, useEffect, useRef, useState } from 'react';
import { X, FolderOpen, FolderClosed, ChevronRight, ChevronDown } from 'lucide-react';
import { quotePathForShell } from '../lib/shell-utils';
import { useWorkspaceStore } from '../store/workspace-store';
import { useCwdStore } from '../store/cwd-store';
import { fuzzyMatch } from '../lib/commands';
import { getFileIcon } from '../lib/file-icons';

// --- Types ---

type DirEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type TreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[] | null; // null = not yet loaded
  isExpanded: boolean;
};

type FlatFile = {
  path: string;
  relativePath: string;
  name: string;
};

// --- localStorage key ---
const ROOT_STORAGE_KEY = 'fleet:file-browser-root';

// --- Helpers ---

function getInitialRoot(): string {
  const stored = localStorage.getItem(ROOT_STORAGE_KEY);
  if (stored) return stored;
  const homeDir = window.fleet.homeDir;
  if (homeDir) return homeDir;
  // Fallback: active pane CWD, then /
  const activePaneId = useWorkspaceStore.getState().activePaneId;
  const cwd = useCwdStore.getState().cwds.get(activePaneId ?? '') ?? '/';
  return cwd;
}

function persistRoot(root: string): void {
  localStorage.setItem(ROOT_STORAGE_KEY, root);
}

function entriesToNodes(entries: DirEntry[]): TreeNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
    children: null, // null = not yet loaded (for dirs) or not applicable (for files)
    isExpanded: false
  }));
}

// --- Props ---

type FileBrowserDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
};

// --- Component ---

export function FileBrowserDrawer({ isOpen, onClose }: FileBrowserDrawerProps): React.JSX.Element | null {
  const [rootDir, setRootDir] = useState<string>(getInitialRoot);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [searchFiles, setSearchFiles] = useState<FlatFile[]>([]);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [isRootLoading, setIsRootLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchLoadedRef = useRef(false);

  // Load root directory on open / root change
  useEffect(() => {
    if (!isOpen) return;
    setNodes([]);
    setSelectedPaths(new Set());
    setQuery('');
    setSearchFiles([]);
    setSearchError(null);
    searchLoadedRef.current = false;
    setIsRootLoading(true);
    void window.fleet.file.readdir(rootDir).then((result) => {
      setIsRootLoading(false);
      if (result.success) {
        setNodes(entriesToNodes(result.entries));
      }
    });
  }, [isOpen, rootDir]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const handleChangeRoot = useCallback(async () => {
    const picked = await window.fleet.showFolderPicker();
    if (!picked) return;
    persistRoot(picked);
    setRootDir(picked);
  }, []);

  const handleExpandNode = useCallback((nodePath: string) => {
    async function updateNodes(ns: TreeNode[]): Promise<TreeNode[]> {
      const result: TreeNode[] = [];
      for (const n of ns) {
        if (n.path === nodePath && n.isDirectory) {
          if (n.isExpanded) {
            result.push({ ...n, isExpanded: false });
          } else if (n.children !== null) {
            result.push({ ...n, isExpanded: true });
          } else {
            const res = await window.fleet.file.readdir(n.path);
            const children = res.success ? entriesToNodes(res.entries) : [];
            result.push({ ...n, isExpanded: true, children });
          }
        } else if (n.isDirectory && n.children) {
          result.push({ ...n, children: await updateNodes(n.children) });
        } else {
          result.push(n);
        }
      }
      return result;
    }
    void updateNodes(nodes).then(setNodes);
  }, [nodes]);

  const toggleSelected = useCallback((filePath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const handleQueryChange = useCallback(
    async (q: string) => {
      setQuery(q);
      if (q && !searchLoadedRef.current) {
        setIsSearchLoading(true);
        searchLoadedRef.current = true;
        try {
          const result = await window.fleet.file.list(rootDir);
          if (result.success) {
            setSearchFiles(result.files);
          } else {
            setSearchError("Couldn't load file list");
          }
        } catch {
          setSearchError("Couldn't load file list");
        } finally {
          setIsSearchLoading(false);
        }
      }
    },
    [rootDir]
  );

  const handleDone = useCallback(() => {
    const activePaneId = useWorkspaceStore.getState().activePaneId;
    if (!activePaneId || selectedPaths.size === 0) return;
    const quoted = Array.from(selectedPaths)
      .map((p) => quotePathForShell(p, window.fleet.platform))
      .join(' ') + ' ';
    window.fleet.pty.input({ paneId: activePaneId, data: quoted });
    onClose();
  }, [selectedPaths, onClose]);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const isTerminalActive = !!activePaneId;

  const filteredSearch = query
    ? searchFiles.filter((f) => fuzzyMatch(query, f.name) || fuzzyMatch(query, f.relativePath))
    : [];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      {/* Drawer */}
      <div className="relative z-10 w-80 h-full flex flex-col bg-neutral-900 border-l border-neutral-700 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800 shrink-0">
          <span className="text-sm font-medium text-neutral-200 flex-1">Browse Files</span>
          <button
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-neutral-200 rounded hover:bg-neutral-800 transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        {/* Root dir */}
        <button
          onClick={() => void handleChangeRoot()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 border-b border-neutral-800 text-left truncate transition-colors hover:bg-neutral-800/50 shrink-0"
          title="Click to change root directory"
        >
          <FolderOpen size={11} className="shrink-0" />
          <span className="truncate">{rootDir}</span>
        </button>
        {/* Search */}
        <div className="px-2 py-1.5 border-b border-neutral-800 shrink-0">
          <input
            type="text"
            value={query}
            onChange={(e) => void handleQueryChange(e.target.value)}
            placeholder="Search files..."
            className="w-full bg-neutral-800 text-sm text-white rounded px-2 py-1 outline-none placeholder-neutral-600 focus:ring-1 focus:ring-neutral-600"
          />
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto py-0.5">
          {query ? (
            <SearchResults
              query={query}
              results={filteredSearch}
              isLoading={isSearchLoading}
              error={searchError}
              selectedPaths={selectedPaths}
              onToggle={toggleSelected}
            />
          ) : (
            <TreeView
              nodes={nodes}
              isLoading={isRootLoading}
              selectedPaths={selectedPaths}
              onToggle={toggleSelected}
              onExpand={(path) => void handleExpandNode(path)}
              depth={0}
            />
          )}
        </div>
        {/* Footer */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-neutral-800 shrink-0">
          <span className="text-xs text-neutral-500 flex-1">
            {selectedPaths.size > 0 ? `${selectedPaths.size} selected` : 'No selection'}
          </span>
          {selectedPaths.size > 0 && (
            <button
              onClick={() => setSelectedPaths(new Set())}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={handleDone}
            disabled={selectedPaths.size === 0 || !isTerminalActive}
            className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            title={!isTerminalActive ? 'Focus a terminal to paste' : undefined}
          >
            Done
          </button>
        </div>
        {!isTerminalActive && selectedPaths.size > 0 && (
          <div className="px-3 pb-2 text-xs text-amber-500/80">
            Focus a terminal to paste
          </div>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

type TreeViewProps = {
  nodes: TreeNode[];
  isLoading: boolean;
  selectedPaths: Set<string>;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
  depth: number;
};

function TreeView({ nodes, isLoading, selectedPaths, onToggle, onExpand, depth }: TreeViewProps): React.JSX.Element {
  if (isLoading) {
    return <div className="px-3 py-2 text-xs text-neutral-500">Loading...</div>;
  }
  if (nodes.length === 0) {
    return <div className="px-3 py-2 text-xs text-neutral-500">This folder is empty</div>;
  }
  return (
    <>
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          selectedPaths={selectedPaths}
          onToggle={onToggle}
          onExpand={onExpand}
          depth={depth}
        />
      ))}
    </>
  );
}

type TreeNodeRowProps = {
  node: TreeNode;
  selectedPaths: Set<string>;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
  depth: number;
};

function TreeNodeRow({ node, selectedPaths, onToggle, onExpand, depth }: TreeNodeRowProps): React.JSX.Element {
  const isSelected = selectedPaths.has(node.path);
  const indent = depth * 12;

  if (node.isDirectory) {
    return (
      <>
        <button
          onClick={() => onExpand(node.path)}
          className="w-full flex items-center gap-1 px-2 py-0.5 text-sm text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors text-left"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          {node.isExpanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          {node.isExpanded ? <FolderOpen size={13} className="shrink-0 text-yellow-500/80" /> : <FolderClosed size={13} className="shrink-0 text-yellow-500/80" />}
          <span className="truncate text-xs">{node.name}</span>
        </button>
        {node.isExpanded && node.children !== null && (
          <TreeView
            nodes={node.children}
            isLoading={false}
            selectedPaths={selectedPaths}
            onToggle={onToggle}
            onExpand={onExpand}
            depth={depth + 1}
          />
        )}
      </>
    );
  }

  return (
    <button
      onClick={() => onToggle(node.path)}
      className={`w-full flex items-center gap-1.5 px-2 py-0.5 text-xs text-left transition-colors ${
        isSelected
          ? 'bg-blue-600/20 text-blue-300'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60'
      }`}
      style={{ paddingLeft: `${8 + indent + 14}px` }}
    >
      <span className="shrink-0 text-neutral-500">{getFileIcon(node.name, 12)}</span>
      <span className="truncate">{node.name}</span>
      {isSelected && <span className="ml-auto shrink-0 text-blue-400">&#x2713;</span>}
    </button>
  );
}

type SearchResultsProps = {
  query: string;
  results: FlatFile[];
  isLoading: boolean;
  error: string | null;
  selectedPaths: Set<string>;
  onToggle: (path: string) => void;
};

function SearchResults({ results, isLoading, error, selectedPaths, onToggle }: SearchResultsProps): React.JSX.Element {
  if (isLoading) {
    return <div className="px-3 py-2 text-xs text-neutral-500">Loading...</div>;
  }
  if (error) {
    return <div className="px-3 py-2 text-xs text-red-400">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="px-3 py-2 text-xs text-neutral-500">No matching files</div>;
  }
  return (
    <>
      {results.map((file) => {
        const isSelected = selectedPaths.has(file.path);
        return (
          <button
            key={file.path}
            onClick={() => onToggle(file.path)}
            className={`w-full flex items-center gap-1.5 px-3 py-1 text-xs text-left transition-colors ${
              isSelected
                ? 'bg-blue-600/20 text-blue-300'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60'
            }`}
          >
            <span className="shrink-0 text-neutral-500">{getFileIcon(file.name, 12)}</span>
            <div className="flex flex-col min-w-0">
              <span className="truncate font-medium">{file.name}</span>
              <span className="truncate text-neutral-600">{file.relativePath}</span>
            </div>
            {isSelected && <span className="ml-auto shrink-0 text-blue-400">&#x2713;</span>}
          </button>
        );
      })}
    </>
  );
}
