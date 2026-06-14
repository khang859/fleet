import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Props = {
  answer: string;
  onDismiss: () => void;
};

export function RuneAnswerPopover({ answer, onDismiss }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    const onClick = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onDismiss();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onDismiss]);
  return (
    <div
      ref={ref}
      className="max-h-72 w-96 overflow-auto rounded-lg border border-fleet-border bg-fleet-surface-2 px-3 py-2 text-sm leading-relaxed text-neutral-100 shadow-xl"
    >
      <div className="prose prose-invert prose-sm max-w-none break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
      </div>
      <div className="mt-2 text-right text-[11px] text-neutral-500">
        click away · esc to dismiss
      </div>
    </div>
  );
}
