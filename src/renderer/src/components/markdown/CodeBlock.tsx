import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Check, Copy } from 'lucide-react';

type CodeBlockProps = ComponentPropsWithoutRef<'pre'>;

/**
 * Custom `pre` renderer for the markdown preview: keeps rehype-highlight's output
 * intact and overlays a hover-revealed Copy button. Reading `textContent` off the
 * rendered <pre> yields clean source code, since highlight.js only wraps tokens in
 * <span>s without inserting any extra text.
 *
 * The button lives on a wrapper div (not the <pre>) so it stays pinned to the visual
 * corner even when a wide code block scrolls horizontally. Defined at module scope —
 * not inline in react-markdown's `components` map — so it isn't remounted on every
 * preview render, which would reset the "Copied" state. (`...props` carries through
 * react-markdown's extra props, matching the existing `a` renderer in MarkdownPane.)
 */
export function CodeBlock({ children, ...props }: CodeBlockProps): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded bg-neutral-700/80 px-1.5 py-0.5 text-xs text-neutral-300 opacity-0 transition-all hover:bg-neutral-600 hover:text-white group-hover:opacity-100 active:scale-90"
        title={copied ? 'Copied!' : 'Copy code'}
        aria-label="Copy code"
      >
        {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  );
}
