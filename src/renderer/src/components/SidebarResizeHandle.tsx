import { useCallback, useRef, useState } from 'react';

/**
 * Drag handle on the right edge of the sidebar. Emits raw pixel widths;
 * clamping happens in the consumer's store action.
 *
 * Uses pointer events (not mouse events) so touch and stylus work too.
 */
export function SidebarResizeHandle({
  sidebarRef,
  onResize,
  onReset
}: {
  sidebarRef: React.RefObject<HTMLDivElement | null>;
  onResize: (widthPx: number) => void;
  onReset: () => void;
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
      const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      onResize(e.clientX - left);
    },
    [isDragging, onResize, sidebarRef]
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
      // Sits in the canvas gutter between the sidebar card and the first pane
      // rather than on the card's rounded edge, so grabbing it never means
      // clicking the last few pixels of a row.
      className="absolute top-0 bottom-0 -right-2 w-2 cursor-col-resize z-20 group flex items-center justify-center"
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
