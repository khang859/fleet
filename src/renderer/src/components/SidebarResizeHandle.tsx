import { useCallback, useRef, useState } from 'react';

/**
 * Drag handle on one edge of a sidebar (the right edge by default). Emits raw
 * pixel widths; clamping happens in the consumer's store action.
 *
 * Uses pointer events (not mouse events) so touch and stylus work too.
 */
export function SidebarResizeHandle({
  sidebarRef,
  onResize,
  onReset,
  edge = 'right'
}: {
  sidebarRef: React.RefObject<HTMLDivElement | null>;
  onResize: (widthPx: number) => void;
  onReset: () => void;
  /** The sidebar edge the handle sits on: `left` for a sidebar docked on the right. */
  edge?: 'left' | 'right';
}): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const previousUserSelectRef = useRef<string>('');

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Left button only; ignore right/middle clicks
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    previousUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      const rect = sidebarRef.current?.getBoundingClientRect();
      if (!rect) return;
      onResize(edge === 'right' ? e.clientX - rect.left : rect.right - e.clientX);
    },
    [isDragging, onResize, sidebarRef, edge]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
    document.body.style.userSelect = previousUserSelectRef.current;
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      // Sits in the canvas gutter between the sidebar card and the nearest pane
      // rather than on the card's rounded edge, so grabbing it never means
      // clicking the last few pixels of a row.
      className={`absolute top-0 bottom-0 ${edge === 'right' ? '-right-2' : '-left-2'} w-2 cursor-col-resize z-20 group flex items-center justify-center`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
    >
      {/* The same pill the pane splitters use, so every gutter in the window
          reveals its handle the same way. */}
      <div
        className={`w-[3px] h-8 rounded-full transition-opacity ${
          isDragging
            ? 'fleet-accent-bg opacity-100'
            : 'bg-fleet-border-strong opacity-0 group-hover:opacity-100'
        }`}
      />
    </div>
  );
}
