import { forwardRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { CodeBlock } from './CodeBlock';
import { useWorkspaceStore } from '../../store/workspace-store';
import { resolve } from '../../lib/path-utils';
import { toFleetImageUrl } from '../../../../shared/path-platform';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

function stripFragmentAndQuery(href: string): string {
  return href.split(/[?#]/)[0];
}

function isMarkdownPath(href: string): boolean {
  const clean = stripFragmentAndQuery(href);
  const ext = clean.split('.').pop()?.toLowerCase() ?? '';
  return MARKDOWN_EXTENSIONS.has(`.${ext}`);
}

function isExternalUrl(href: string): boolean {
  return /^https?:\/\//.test(href);
}

type Props = {
  content: string;
  /** Directory that relative image/link `src`/`href`s resolve against. */
  baseDir: string;
  className?: string;
};

/**
 * Fleet-aware Markdown renderer shared by the file preview (MarkdownPane) and the
 * project Notes pane. Local images resolve through the fleet-image protocol,
 * relative links open in Fleet, external links open in the system browser, and
 * fenced code uses Fleet's CodeBlock chrome. The forwarded ref targets the
 * scrollable content container (used for find-in-doc and copy).
 */
export const MarkdownPreview = forwardRef<HTMLDivElement, Props>(function MarkdownPreview(
  { content, baseDir, className },
  ref
) {
  const openFileInTab = useWorkspaceStore((s) => s.openFileInTab);

  const components = useMemo<Components>(
    () => ({
      pre: CodeBlock,
      // Local image links (`![alt](./foo.png)`) resolve against baseDir and load
      // through the fleet-image protocol — the app's HTML base can't resolve a
      // path relative to the document on disk, and a bare file:// path is not
      // loadable from the renderer. Remote (http/https) and inline (data:) images,
      // and already-resolved fleet-image URLs, pass through untouched.
      img: ({ src, alt, ...props }) => {
        const resolvedSrc =
          src && !/^(https?:|data:|fleet-image:)/i.test(src)
            ? toFleetImageUrl(resolve(baseDir, src.replace(/^file:\/\//i, '')))
            : src;
        return <img src={resolvedSrc} alt={alt ?? ''} {...props} />;
      },
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
                void window.fleet.shell.openExternal(href);
              }}
              {...props}
            >
              {children}
            </a>
          );
        }

        // Relative links — open in Fleet
        const cleanHref = stripFragmentAndQuery(href);
        const resolvedPath = resolve(baseDir, cleanHref);
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

  return (
    <div ref={ref} className={className ?? 'markdown-preview'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
