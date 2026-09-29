import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Links and images are drawn as text: the overlay is for reading aloud, and a
 * stray click on a locked-then-unlocked window must never navigate it.
 */
const COMPONENTS: Components = {
  a: ({ children }) => <span className="underline decoration-white/30">{children}</span>,
  img: ({ alt }) => <span className="text-white/60">[{alt || 'image'}]</span>
};

export function Notes({
  markdown,
  fontSize
}: {
  markdown: string;
  fontSize: number;
}): React.JSX.Element {
  return (
    <div className="tp-notes" style={{ fontSize }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
