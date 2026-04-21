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
      className={`absolute top-0 bottom-0 -right-0.5 w-1 cursor-col-resize z-20 group ${
        isDragging ? '' : 'hover:bg-blue-500/0'
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
    >
      {/* Visual accent — transparent by default, blue on hover/active */}
      <div
        className={`absolute top-0 bottom-0 left-0 right-0 transition-colors ${
          isDragging ? 'bg-blue-500/80' : 'bg-transparent group-hover:bg-blue-500/50'
        }`}
      />
    </div>
  );
}
