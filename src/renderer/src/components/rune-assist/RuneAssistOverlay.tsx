import { useEffect, useRef } from 'react';

type Props = {
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function RuneAssistOverlay({
  draft,
  onChange,
  onSubmit,
  onClose
}: Props): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="w-80 rounded-lg border border-fleet-border bg-fleet-surface-2 shadow-xl">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        placeholder="Ask or instruct Rune…"
        className="w-full resize-none bg-transparent px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="flex items-center gap-2 border-t border-fleet-border px-3 py-1.5 text-[11px] text-neutral-500">
        <span>⏎ send</span>
        <span>· esc close</span>
        <span className="ml-auto text-neutral-600">imperative → edit · else ask</span>
      </div>
    </div>
  );
}
