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
    // Clicking here focuses the pane and double-clicking renames it, so it has
    // to look like it will do something - but the affordance lives on the pill,
    // not on the row, since the row is invisible.
    //
    // The pill is also where the pane says whether it has focus: lit ground and
    // brighter text when it does, flat and grey when it does not. See the note
    // on `PaneFrame` for why focus is not an accent ring. `group/header` is
    // what lets hovering anywhere on the row light the pill, so the whole width
    // still feels live even though only part of it is drawn.
    <div
      className="group/header flex items-center gap-1.5 h-7 px-1.5 text-xs text-fleet-text-subtle group-data-[pane-active=true]/pane:text-fleet-text-secondary select-none shrink-0"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title={isEditing ? undefined : `${liveCwd ?? ''}\nDouble-click to rename`}
    >
      {/* The ground rides on the pill, not on the row. The row still spans the
          pane - it is the click and double-click target, and a full-width
          target is the whole reason rename is easy to hit - but it paints
          nothing, so the terminal reads as one surface with a label floating on
          it rather than as output stacked under a strip of chrome.

          Crucially the row is still in flow. An absolutely positioned chip
          would need the terminal padded by exactly its height to avoid covering
          the first row, and that number would drift the moment either side
          changed. A flow element cannot overlap what follows it. */}
      {/* Hover has to be declared for both focus states, or the active variant -
          being the more specific selector - would swallow it and hovering a
          focused pane would visibly dim its title.

          Both pills are pinned to the same height rather than left to their own
          padding: the toolbar's is set by its icon buttons and the title's by
          its line box, and those land 2px apart, which reads as a wobble
          between two things that sit on the same line. */}
      <div className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-full px-2 bg-fleet-glass-surface group-hover/header:bg-fleet-glass-surface-2 group-data-[pane-active=true]/pane:bg-fleet-glass-surface-3 group-data-[pane-active=true]/pane:group-hover/header:bg-fleet-glass-surface-3 transition-colors">
        <PaneStatusGlyph state={activityState} className="shrink-0" />
        {isEditing ? (
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-fleet-text text-xs font-mono outline-none border-none px-0"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="truncate font-mono cursor-default group-hover/header:text-fleet-text transition-colors">
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
      </div>
      {/* Pushes the actions to the far edge and, while they are hidden, gives
          the row something to fill it so the pill does not stretch. */}
      <div className="min-w-0 flex-1" />
      {/* Icons floating bare over a wallpaper are hard to read, so they get a
          pill of their own. The toolbar hides itself when the pane is not
          hovered, and this ground is keyed to the same hover, so the icons and
          the pill they sit on arrive together. */}
      {actions && (
        <div className="flex h-[22px] shrink-0 items-center rounded-full px-0.5 transition-colors group-hover/pane:bg-fleet-glass-surface">
          {actions}
        </div>
      )}
    </div>
  );
}
