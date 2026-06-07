import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Copy, FileCode, Search, TextSelect, Type } from 'lucide-react';
import { popperAnim } from '../../lib/motion';

type MarkdownContextMenuProps = {
  children: React.ReactNode;
  /** Trimmed text of the current preview selection, or '' when nothing is selected. */
  getSelectedText: () => string;
  onCopySelection: () => void;
  onCopyMarkdown: () => void;
  onCopyText: () => void;
  onSelectAll: () => void;
  onFind: () => void;
};

const itemClass =
  'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 data-[disabled]:opacity-40 data-[disabled]:cursor-default data-[disabled]:hover:bg-transparent';

/**
 * Right-click menu for the markdown preview. Selection-aware: "Copy" is enabled only
 * when text is highlighted (computed when the menu opens). Document-level copy, select
 * all, and find round out the actions.
 */
export function MarkdownContextMenu({
  children,
  getSelectedText,
  onCopySelection,
  onCopyMarkdown,
  onCopyText,
  onSelectAll,
  onFind
}: MarkdownContextMenuProps): React.JSX.Element {
  const [hasSelection, setHasSelection] = useState(false);

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) setHasSelection(getSelectedText().length > 0);
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={`min-w-[200px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
        >
          <ContextMenu.Item
            className={itemClass}
            disabled={!hasSelection}
            onSelect={onCopySelection}
          >
            <Copy size={14} />
            Copy
          </ContextMenu.Item>
          <ContextMenu.Item className={itemClass} onSelect={onSelectAll}>
            <TextSelect size={14} />
            Select all
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
          <ContextMenu.Item className={itemClass} onSelect={onCopyMarkdown}>
            <FileCode size={14} />
            Copy document as Markdown
          </ContextMenu.Item>
          <ContextMenu.Item className={itemClass} onSelect={onCopyText}>
            <Type size={14} />
            Copy document as Text
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
          <ContextMenu.Item className={itemClass} onSelect={onFind}>
            <Search size={14} />
            Find…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
