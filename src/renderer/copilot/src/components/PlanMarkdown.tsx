import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';

/**
 * Sized for the card's 11px text. Links and images are drawn as text: the
 * panel has nowhere to open them, and a stray click must not navigate it.
 */
const heading: Components['h1'] = ({ children }) => (
  <p className="mt-2 first:mt-0 font-semibold text-neutral-100">{children}</p>
);

const COMPONENTS: Components = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  p: ({ children }) => <p className="mt-1 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-1 list-disc pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1 list-decimal pl-4">{children}</ol>,
  li: ({ children }) => <li className="mt-0.5">{children}</li>,
  code: ({ children }) => (
    <code className="rounded bg-neutral-900/60 px-0.5 font-mono text-[10px]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mt-1 overflow-x-auto rounded bg-neutral-900/60 p-1 [&_code]:bg-transparent">
      {children}
    </pre>
  ),
  a: ({ children }) => <span className="underline decoration-neutral-500">{children}</span>,
  img: ({ alt }) => <span className="text-neutral-500">[{alt || 'image'}]</span>
};

/** The plan Claude asks to start on, as Markdown. */
export function PlanMarkdown({
  plan,
  compact
}: {
  plan: string;
  compact: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'overflow-y-auto rounded bg-neutral-800/50 px-1.5 py-1 text-[11px] text-neutral-300 [overflow-wrap:anywhere]',
        compact ? 'max-h-24' : 'max-h-64'
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {plan}
      </ReactMarkdown>
    </div>
  );
}
