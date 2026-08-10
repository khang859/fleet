import { useState, useEffect, useRef, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { useCwdStore } from '../store/cwd-store';
import { useWorkspaceStore } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { PaneStatusGlyph } from './PaneStatusGlyph';
import { shortenPath } from '../lib/shorten-path';

type PaneHeaderProps = {
  paneId: string;
  label?: string;
  labelIsCustom?: boolean;
  /**
   * Pane actions, laid out after the title rather than floated over the pane.
   * Being a flex sibling is the point: the title truncates to whatever room the
   * actions leave, so the two can never overlap however wide either one gets.
   */
  actions?: React.ReactNode;
};

export function PaneHeader({
  paneId,
  label,
  labelIsCustom,
  actions
}: PaneHeaderProps): React.JSX.Element {
  const liveCwd = useCwdStore((s) => s.cwds.get(paneId));
  const renamePane = useWorkspaceStore((s) => s.renamePane);
  const resetPaneLabel = useWorkspaceStore((s) => s.resetPaneLabel);
  // The glyph used to float in the pane's top-right corner, which is where the
  // actions now live. It belongs at the head of the title bar anyway: status
  // reads as a property of the pane's name, not as a mark on its output.
  const activityState = useNotificationStore((s) => s.activities.get(paneId)?.state);

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

  // On the bar rather than on the title text. The title is only as wide as the
  // path is long, and the actions take the rest of the row, so hanging rename
  // off the text alone left a target most double-clicks miss. Anything that
  // handles its own clicks (the action buttons) is excluded.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('button')) return;
      setEditValue(displayText);
      setIsEditing(true);
    },
    [displayText]
  );

  // While the rename field is open the bar stops being a click-through to the
  // pane. `TerminalPane`'s container `onClick` focuses xterm, and xterm taking
  // focus blurs this input - which commits and closes the rename on the
  // trailing click of the double-click that opened it, and again the moment you
  // click into the field to edit. Bubble phase, so the input itself still gets
  // the click and can put the caret where it was aimed.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) e.stopPropagation();
    },
    [isEditing]
  );

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
    // Clicking the bar focuses the pane and double-clicking renames it, so it
    // has to look like it will do something. Without a hover state it read as
    // a dead strip of chrome.
    <div
      className="group/header flex items-center gap-1.5 h-7 pl-2 pr-1 bg-fleet-glass-surface-2 hover:bg-fleet-glass-surface-3 border-b border-fleet-border text-xs text-fleet-text-secondary select-none shrink-0 transition-colors"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={isEditing ? undefined : `${liveCwd ?? ''}\nDouble-click to rename`}
    >
      <PaneStatusGlyph state={activityState} className="shrink-0" />
      {isEditing ? (
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-fleet-text text-xs font-mono outline-none border-none px-0"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <span className="flex-1 truncate font-mono cursor-default group-hover/header:text-fleet-text transition-colors">
          {displayText}
        </span>
      )}
      {labelIsCustom && !isEditing && (
        // An icon, not the words "clear title". As running text in a bar whose
        // other job is showing a path, it read as part of the title rather than
        // as a control.
        <button
          className="shrink-0 rounded p-0.5 text-fleet-text-subtle hover:text-fleet-text hover:bg-fleet-surface-3 transition-colors active:scale-90 focus-ring"
          onClick={() => resetPaneLabel(paneId)}
          title="Clear custom title and show path"
          aria-label="Clear pane title"
        >
          <RotateCcw size={12} />
        </button>
      )}
      {actions}
    </div>
  );
}
