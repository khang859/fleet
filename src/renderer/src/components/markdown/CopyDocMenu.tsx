import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Copy } from 'lucide-react';
import { useToastStore } from '../../store/toast-store';
import { popperAnim } from '../../lib/motion';

type CopyDocMenuProps = {
  /** Raw markdown source of the document. */
  getMarkdown: () => string;
  /** Rendered plain text of the preview (no markdown syntax). */
  getText: () => string;
};

/**
 * "Copy as…" menu for the markdown preview — copies the whole document either as
 * raw markdown source or as rendered plain text. Lives in the Preview/Raw sub-tab bar.
 */
export function CopyDocMenu({ getMarkdown, getText }: CopyDocMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const showToast = useToastStore((s) => s.show);

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      showToast(label);
      setOpen(false);
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-500 transition-colors hover:text-neutral-300 active:scale-[0.97]"
          title="Copy document"
        >
          <Copy size={12} />
          Copy as
          <ChevronDown size={10} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className={`z-50 min-w-[170px] rounded-md border border-neutral-700 bg-neutral-800 p-1 shadow-lg ${popperAnim}`}
        >
          <button
            type="button"
            className="w-full rounded px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
            onClick={() => copy(getMarkdown(), 'Copied as Markdown')}
          >
            Copy as Markdown
          </button>
          <button
            type="button"
            className="w-full rounded px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white"
            onClick={() => copy(getText(), 'Copied as plain text')}
          >
            Copy as Text
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
