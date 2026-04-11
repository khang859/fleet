import { useState, useEffect, useRef, useCallback } from 'react';
import { useCwdStore } from '../store/cwd-store';
import { useWorkspaceStore } from '../store/workspace-store';
import { shortenPath } from '../lib/shorten-path';

type PaneHeaderProps = {
  paneId: string;
  label?: string;
  labelIsCustom?: boolean;
};

export function PaneHeader({ paneId, label, labelIsCustom }: PaneHeaderProps): React.JSX.Element {
  const liveCwd = useCwdStore((s) => s.cwds.get(paneId));
  const renamePane = useWorkspaceStore((s) => s.renamePane);
  const resetPaneLabel = useWorkspaceStore((s) => s.resetPaneLabel);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const displayText = labelIsCustom && label ? label : shortenPath(liveCwd ?? '');

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Listen for Shift+F2 rename event targeting this pane
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const detail = e.detail as { paneId?: string } | undefined;
      if (detail?.paneId === paneId) {
        setEditValue(displayText);
        setIsEditing(true);
      }
    };
    document.addEventListener('fleet:rename-active-pane', handler);
    return () => document.removeEventListener('fleet:rename-active-pane', handler);
  }, [paneId, displayText]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== displayText) {
      renamePane(paneId, trimmed);
    }
    setIsEditing(false);
  }, [editValue, displayText, renamePane, paneId]);

  const handleDoubleClick = useCallback(() => {
    setEditValue(displayText);
    setIsEditing(true);
  }, [displayText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
      }
    },
    [commitRename]
  );

  return (
    <div className="flex items-center h-6 px-2 bg-neutral-900 border-b border-neutral-800 text-xs text-neutral-400 select-none shrink-0">
      {isEditing ? (
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-neutral-200 text-xs font-mono outline-none border-none px-0"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <span
          className="flex-1 truncate font-mono cursor-default"
          onDoubleClick={handleDoubleClick}
          title={liveCwd ?? ''}
        >
          {displayText}
        </span>
      )}
      {labelIsCustom && !isEditing && (
        <button
          className="ml-1 text-neutral-500 hover:text-neutral-300 transition-colors"
          onClick={() => resetPaneLabel(paneId)}
          title="Reset to path"
          aria-label="Reset pane name"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 2l6 6M8 2l-6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
