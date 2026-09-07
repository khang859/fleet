import { useEffect, useRef, useState } from 'react';
import type { Mermaid } from 'mermaid';

/**
 * Mermaid is ~1 MB of JS, so it is imported on first use rather than at module
 * load — a markdown file without a `mermaid` fence never pays for it. The
 * promise is module-level so the second diagram on a page reuses the first
 * load, and `initialize` runs exactly once.
 */
let mermaidPromise: Promise<Mermaid> | null = null;

async function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      // Default level: HTML in labels is escaped and `click` handlers are
      // dropped. Markdown files are often written by agents, so the diagram
      // source is untrusted input.
      securityLevel: 'strict',
      // Without this, a failed render appends mermaid's own error SVG to the
      // document body. We show the error inline instead.
      suppressErrorRendering: true,
      fontFamily: 'inherit'
    });
    return mermaid;
  });
  return mermaidPromise;
}

/** Mermaid uses this as a DOM id, so it has to be selector-safe (no `:` from useId). */
let diagramSeq = 0;

type Props = {
  /** Raw text of the ```mermaid fence. */
  code: string;
};

/**
 * Renders one ```mermaid fence as an SVG inside the markdown preview. On a
 * parse error it falls back to the diagram source plus mermaid's message, so a
 * typo is visible and fixable rather than silently blank.
 */
export function MermaidDiagram({ code }: Props): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `fleet-mermaid-${(diagramSeq += 1)}`;

    void loadMermaid()
      .then(async (mermaid) => mermaid.render(id, code))
      .then(({ svg: rendered, bindFunctions }) => {
        if (cancelled) return;
        setError(null);
        setSvg(rendered);
        // Runs after React has committed the SVG, so the nodes exist.
        queueMicrotask(() => {
          if (!cancelled && containerRef.current) bindFunctions?.(containerRef.current);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error !== null) {
    return (
      <div className="mermaid-error">
        <pre>{code}</pre>
        <div className="mermaid-error-message">Mermaid: {error}</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      // Mermaid returns a self-contained SVG string; there is no React tree for it.
      dangerouslySetInnerHTML={svg === null ? undefined : { __html: svg }}
    />
  );
}
