import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { FileEditorPane } from './FileEditorPane';
import { PathChromeHeader } from './PathChromeHeader';
import { MarkdownPreview } from './markdown/MarkdownPreview';
import { CopyDocMenu } from './markdown/CopyDocMenu';
import { MarkdownFindBar } from './markdown/MarkdownFindBar';
import { MarkdownContextMenu } from './markdown/MarkdownContextMenu';
import { useMarkdownFind } from '../hooks/use-markdown-find';
import { useToastStore } from '../store/toast-store';
import { dirname } from '../lib/path-utils';
import type { PathContext } from '../../../shared/shell-profiles';
import type { RemoteFileRef } from '../../../shared/remote-ssh-types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

type Props = {
  paneId: string;
  filePath: string;
  pathContext?: PathContext;
  /** Set when `filePath` is the local cache copy of a remote file - see FileEditorPane. */
  remote?: RemoteFileRef;
};

type ViewMode = 'preview' | 'raw';

export function MarkdownPane({ paneId, filePath, pathContext, remote }: Props): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewMode>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [previewContent, setPreviewContent] = useState<string>('');
  const contentRef = useRef<string>('');
  const previewRef = useRef<HTMLDivElement>(null);

  // Find-in-document (preview only)
  const [searchOpen, setSearchOpen] = useState(false);
  const {
    query,
    setQuery,
    matchCount,
    currentIndex,
    next: findNext,
    prev: findPrev,
    clear: clearFind
  } = useMarkdownFind(previewRef, previewContent, paneId);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    clearFind();
  }, [setQuery, clearFind]);

  // Cmd/Ctrl+F toggles the find bar — reuses the global "Search in pane" event,
  // which carries the active paneId. Preview view only; Raw uses the editor's own search.
  const activeViewRef = useRef<ViewMode>(activeView);
  activeViewRef.current = activeView;
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const detail: unknown = e.detail;
      if (typeof detail !== 'object' || detail === null || !('paneId' in detail)) return;
      if (detail.paneId !== paneId) return;
      if (activeViewRef.current !== 'preview') return;
      if (searchOpenRef.current) closeSearch();
      else setSearchOpen(true);
    };
    document.addEventListener('fleet:toggle-search', handler);
    return () => document.removeEventListener('fleet:toggle-search', handler);
  }, [paneId, closeSearch]);

  // ── Copy helpers (shared by auto-copy, the context menu, and copy-feedback) ──
  const showToast = useToastStore((s) => s.show);

  const copyText = useCallback(
    (text: string, label: string) => {
      if (!text) return;
      void navigator.clipboard.writeText(text).then(() => showToast(label));
    },
    [showToast]
  );

  // The current selection's text, but only if it lives inside the preview.
  const getSelectedText = useCallback((): string => {
    const el = previewRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    if (!el.contains(sel.getRangeAt(0).commonAncestorContainer)) return '';
    return sel.toString().trim();
  }, []);

  const copySelection = useCallback(() => {
    copyText(getSelectedText(), 'Copied selection');
  }, [copyText, getSelectedText]);

  const selectAllDoc = useCallback(() => {
    const el = previewRef.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  // Cmd/Ctrl+A inside the preview selects only the document, not the whole app.
  const handlePreviewKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        if (!previewRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        selectAllDoc();
      }
    },
    [selectAllDoc]
  );

  // Auto-copy on highlight: when a drag/selection settles, copy it. Confirms with a toast.
  const handlePreviewMouseUp = useCallback(() => {
    copyText(getSelectedText(), 'Copied selection');
  }, [copyText, getSelectedText]);

  // Native Cmd/Ctrl+C: the browser already copied the selection — just confirm it.
  const handlePreviewCopy = useCallback(() => {
    if (getSelectedText()) showToast('Copied selection');
  }, [getSelectedText, showToast]);

  // Load file content on mount
  useEffect(() => {
    void window.fleet.file.read(filePath, pathContext).then((result) => {
      if (result.success && result.data) {
        if (result.data.size > MAX_FILE_SIZE) {
          setTooLarge(true);
          setFileSize(result.data.size);
        } else {
          contentRef.current = result.data.content;
          setPreviewContent(result.data.content);
        }
      } else {
        setError(('error' in result ? result.error : undefined) ?? 'Failed to read file');
      }
      setLoading(false);
    });
  }, [filePath, pathContext]);

  // Sync content from editor to contentRef
  const handleContentChange = useCallback((content: string) => {
    contentRef.current = content;
  }, []);

  // Refresh preview content when switching to preview tab
  const handleTabSwitch = useCallback(
    (view: ViewMode) => {
      if (view === 'preview') {
        setPreviewContent(contentRef.current);
      } else {
        // Leaving preview — tear down any open find so highlights don't linger.
        closeSearch();
      }
      setActiveView(view);
    },
    [closeSearch]
  );

  // Relative images/links in the preview resolve against the file's directory.
  // For a remote doc that is the cache directory, so siblings won't resolve -
  // a known limitation of viewing a single fetched file rather than a tree.
  const baseDir = useMemo(() => dirname(filePath), [filePath]);

  // Users think in terms of the remote path, not the cache copy backing it.
  const displayPath = remote ? `${remote.host.label}:${remote.path}` : filePath;

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#282c34] text-neutral-400 text-sm">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#282c34] text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  if (tooLarge) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#282c34] text-neutral-400 text-sm gap-2">
        <div className="text-3xl text-neutral-500">⚠</div>
        <div className="font-medium text-neutral-200">File too large to preview</div>
        <div className="text-neutral-500">
          {(fileSize / 1024 / 1024).toFixed(1)} MB — limit is 10 MB
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-[#282c34]">
      <PathChromeHeader filePath={displayPath} />

      {/* Sub-tab bar */}
      <div className="flex-shrink-0 flex items-center gap-0 border-b border-neutral-800 bg-neutral-950/60 px-2">
        <button
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors active:scale-[0.97] ${
            activeView === 'preview'
              ? 'border-teal-400 text-neutral-100'
              : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
          onClick={() => handleTabSwitch('preview')}
        >
          Preview
        </button>
        <button
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors active:scale-[0.97] ${
            activeView === 'raw'
              ? 'border-teal-400 text-neutral-100'
              : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
          onClick={() => handleTabSwitch('raw')}
        >
          Raw
        </button>

        {activeView === 'preview' && (
          <div className="ml-auto">
            <CopyDocMenu
              getMarkdown={() => contentRef.current}
              getText={() => previewRef.current?.innerText ?? ''}
            />
          </div>
        )}
      </div>

      {/* Content area — both views stay mounted to preserve editor state */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <MarkdownContextMenu
          getSelectedText={getSelectedText}
          onCopySelection={copySelection}
          onCopyMarkdown={() => copyText(contentRef.current, 'Copied as Markdown')}
          onCopyText={() => copyText(previewRef.current?.innerText ?? '', 'Copied as plain text')}
          onSelectAll={selectAllDoc}
          onFind={() => setSearchOpen(true)}
        >
          <div
            className={`h-full overflow-y-auto outline-none ${activeView === 'preview' ? '' : 'hidden'}`}
            tabIndex={0}
            onKeyDown={handlePreviewKeyDown}
            onMouseUp={handlePreviewMouseUp}
            onCopy={handlePreviewCopy}
          >
            <MarkdownPreview
              ref={previewRef}
              content={previewContent}
              baseDir={baseDir}
              className="max-w-3xl mx-auto px-8 py-6 text-neutral-300 leading-relaxed markdown-preview"
            />
          </div>
        </MarkdownContextMenu>
        <div className={`h-full ${activeView === 'raw' ? '' : 'hidden'}`}>
          <FileEditorPane
            paneId={paneId}
            filePath={filePath}
            pathContext={pathContext}
            remote={remote}
            onContentChange={handleContentChange}
            showPathChrome={false}
          />
        </div>
        {activeView === 'preview' && (
          <MarkdownFindBar
            isOpen={searchOpen}
            query={query}
            matchCount={matchCount}
            currentIndex={currentIndex}
            onQueryChange={setQuery}
            onNext={findNext}
            onPrev={findPrev}
            onClose={closeSearch}
          />
        )}
      </div>

      {/* Footer with path */}
      <div className="flex-shrink-0 flex items-center px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-500">
        <span className="font-mono truncate min-w-0" title={displayPath}>
          {displayPath}
        </span>
      </div>
    </div>
  );
}
