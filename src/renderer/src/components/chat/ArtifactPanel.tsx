import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, Download, Eye, Code2, X } from 'lucide-react';
import { useChatStore, type OpenArtifact } from '../../store/chat-store';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { CodeBlock } from '../markdown/CodeBlock';

const EXT: Record<string, string> = { html: 'html', svg: 'svg', markdown: 'md' };

/**
 * Right-side panel for a model-produced artifact. Renders a live preview (html/svg
 * in a sandboxed iframe, markdown via the same renderer the chat uses) alongside an
 * editable source view. Edits are local to the panel — re-rendering the preview
 * live — and never mutate the conversation. Opening a different artifact remounts
 * this component (keyed on the artifact id upstream), resetting the draft.
 *
 * `presenceOpen` drives the open/close width animation; the parent keeps this
 * mounted through the exit (via usePresence) so the panel slides shut instead of
 * vanishing.
 */
export function ArtifactPanel({
  artifact,
  presenceOpen
}: {
  artifact: OpenArtifact;
  presenceOpen: boolean;
}): React.JSX.Element {
  const close = useChatStore((s) => s.closeArtifact);
  const reduced = useReducedMotion();
  const [draft, setDraft] = useState(artifact.code);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = (): void => {
    void navigator.clipboard.writeText(draft).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  const download = (): void => {
    const blob = new Blob([draft], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `artifact.${EXT[artifact.kind] ?? 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    // Outer animates width (40% ↔ 0) so the message column reflows smoothly with
    // no instant layout jump; overflow-hidden clips the fixed-width inner during
    // the slide. Reduced-motion collapses the transition to 0ms.
    <div
      className={`flex h-full shrink-0 flex-col overflow-hidden border-l border-fleet-border bg-fleet-surface transition-[width] ease-[cubic-bezier(.25,1,.5,1)] ${
        reduced ? 'duration-0' : 'duration-[220ms]'
      } ${presenceOpen ? 'w-[40%] min-w-[320px]' : 'w-0 min-w-0'}`}
    >
      <div className="flex h-full min-w-[320px] flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-fleet-border px-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm text-fleet-text">{artifact.title}</span>
            <span className="shrink-0 rounded bg-fleet-surface-3 px-1.5 py-0.5 text-[10px] uppercase text-fleet-text-muted">
              {artifact.kind}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setTab(tab === 'preview' ? 'code' : 'preview')}
              title={tab === 'preview' ? 'Show source' : 'Show preview'}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fleet-text-muted hover:text-fleet-text"
            >
              {tab === 'preview' ? <Code2 size={13} /> : <Eye size={13} />}
              {tab === 'preview' ? 'Source' : 'Preview'}
            </button>
            <button
              onClick={copy}
              title="Copy source"
              aria-label="Copy source"
              className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>
            <button
              onClick={download}
              title="Download"
              aria-label="Download artifact"
              className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
            >
              <Download size={13} />
            </button>
            <button
              onClick={close}
              title="Close"
              aria-label="Close artifact"
              className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'code' ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none bg-fleet-surface-2 p-3 font-mono text-xs text-fleet-text outline-none"
            />
          ) : artifact.kind === 'markdown' ? (
            <div className="h-full overflow-y-auto p-4">
              <div className="prose prose-invert max-w-none prose-pre:bg-fleet-surface-3">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                  components={{ pre: CodeBlock }}
                >
                  {draft}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <iframe
              title={artifact.title}
              sandbox="allow-scripts"
              srcDoc={draft}
              className="h-full w-full border-0 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}
