import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { FileEditorPane } from './FileEditorPane';
import { useWorkspaceStore } from '../store/workspace-store';
import { dirname, resolve } from '../lib/path-utils';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

type Props = {
  paneId: string;
  filePath: string;
};

type ViewMode = 'preview' | 'raw';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

function isMarkdownPath(href: string): boolean {
  const ext = href.split('.').pop()?.toLowerCase() ?? '';
  return MARKDOWN_EXTENSIONS.has(`.${ext}`);
}

function isExternalUrl(href: string): boolean {
  return /^https?:\/\//.test(href);
}

export function MarkdownPane({ paneId, filePath }: Props): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewMode>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [previewContent, setPreviewContent] = useState<string>('');
  const contentRef = useRef<string>('');
  const openFileInTab = useWorkspaceStore((s) => s.openFileInTab);

  // Load file content on mount
  useEffect(() => {
    void window.fleet.file.read(filePath).then((result) => {
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
  }, [filePath]);

  // Sync content from editor to contentRef
  const handleContentChange = useCallback((content: string) => {
    contentRef.current = content;
  }, []);

  // Refresh preview content when switching to preview tab
  const handleTabSwitch = useCallback(
    (view: ViewMode) => {
      if (view === 'preview') {
        setPreviewContent(contentRef.current);
      }
      setActiveView(view);
    },
    []
  );

  // Custom link renderer for Fleet-aware navigation
  const baseDir = useMemo(() => dirname(filePath), [filePath]);

  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children, ...props }) => {
        if (!href) return <span {...props}>{children}</span>;

        // Anchor links — scroll within preview
        if (href.startsWith('#')) {
          return (
            <a
              href={href}
              className="text-blue-400 hover:underline cursor-pointer"
              onClick={(e) => {
                e.preventDefault();
                const target = document.getElementById(href.slice(1));
                target?.scrollIntoView({ behavior: 'smooth' });
              }}
              {...props}
            >
              {children}
            </a>
          );
        }

        // External URLs — open in system browser
        if (isExternalUrl(href)) {
          return (
            <a
              href={href}
              className="text-blue-400 hover:underline cursor-pointer"
              onClick={(e) => {
                e.preventDefault();
                window.open(href);
              }}
              {...props}
            >
              {children}
            </a>
          );
        }

        // Relative links — open in Fleet
        const resolvedPath = resolve(baseDir, href);
        const paneType = isMarkdownPath(href) ? 'markdown' : 'file';
        const label = href.split('/').pop() ?? href;

        return (
          <a
            href={href}
            className="text-blue-400 hover:underline cursor-pointer"
            onClick={(e) => {
              e.preventDefault();
              openFileInTab([{ path: resolvedPath, paneType, label }]);
            }}
            {...props}
          >
            {children}
          </a>
        );
      }
    }),
    [baseDir, openFileInTab]
  );

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
      {/* Sub-tab bar */}
      <div className="flex-shrink-0 flex items-center gap-0 border-b border-neutral-800 bg-neutral-950/60 px-2">
        <button
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
            activeView === 'preview'
              ? 'border-teal-400 text-neutral-100'
              : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
          onClick={() => handleTabSwitch('preview')}
        >
          Preview
        </button>
        <button
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
            activeView === 'raw'
              ? 'border-teal-400 text-neutral-100'
              : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
          onClick={() => handleTabSwitch('raw')}
        >
          Raw
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeView === 'preview' ? (
          <div className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-8 py-6 text-neutral-300 leading-relaxed markdown-preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {previewContent}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <FileEditorPane
            paneId={paneId}
            filePath={filePath}
            onContentChange={handleContentChange}
          />
        )}
      </div>
    </div>
  );
}
