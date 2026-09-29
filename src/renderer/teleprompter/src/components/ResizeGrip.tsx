import { useRef } from 'react';

type Drag = { x: number; y: number; width: number; height: number; frame: number | null };

/**
 * The overlay's resize handle. Transparent windows cannot be resized by the
 * OS on every platform, so the size is streamed to main, which clamps it to
 * the display.
 */
export function ResizeGrip(): React.JSX.Element {
  const drag = useRef<Drag | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.screenX,
      y: e.screenY,
      width: window.innerWidth,
      height: window.innerHeight,
      frame: null
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const width = d.width + e.screenX - d.x;
    const height = d.height + e.screenY - d.y;
    // One resize per frame; pointer events arrive much faster than the window can follow.
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    d.frame = requestAnimationFrame(() => {
      d.frame = null;
      window.teleprompter.resize(width, height);
    });
  };

  const onPointerUp = (): void => {
    drag.current = null;
  };

  return (
    <div
      role="presentation"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute bottom-0 right-0 flex size-5 cursor-nwse-resize items-end justify-end p-1 text-white/25 hover:text-white/60"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <svg viewBox="0 0 8 8" className="size-2" aria-hidden="true">
        <path d="M7 1 1 7M7 4 4 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </div>
  );
}
