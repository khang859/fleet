import { useEffect, useRef } from 'react';

type Props = {
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  mode: 'ask' | 'edit';
  onToggleMode: () => void;
};

export function RuneAssistOverlay({
  draft,
  onChange,
  onSubmit,
  onClose,
  mode,
  onToggleMode
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
        <button
          type="button"
          onClick={onToggleMode}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-fleet-surface-3"
          title="Click to switch. Edit lets Rune modify the file; Ask is read-only."
          aria-label={`Mode: ${mode === 'edit' ? 'Edit (writes to the file)' : 'Ask (read-only)'}. Click to switch.`}
        >
          {mode === 'edit' ? '✎ Edit' : '? Ask'}
        </button>
      </div>
    </div>
  );
}
