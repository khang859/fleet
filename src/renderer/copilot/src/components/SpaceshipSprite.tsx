import { useRef, useCallback } from 'react';
import { useCopilotStore } from '../store/copilot-store';

const SPRITE_SIZE = 48;
const DRAG_THRESHOLD = 4;

type SpriteState = 'idle' | 'processing' | 'permission' | 'complete';

function useSpriteState(): SpriteState {
  const sessions = useCopilotStore((s) => s.sessions);
  if (sessions.length === 0) return 'idle';
  const hasPermission = sessions.some((s) => s.pendingPermissions.length > 0);
  if (hasPermission) return 'permission';
  const hasProcessing = sessions.some((s) => s.phase === 'processing' || s.phase === 'compacting');
  if (hasProcessing) return 'processing';
  return 'idle';
}

export function SpaceshipSprite(): React.JSX.Element {
  const spriteState = useSpriteState();
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);

  const wasDragged = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    wasDragged.current = false;
    dragStartPos.current = { x: e.screenX, y: e.screenY };

    window.copilot.getPosition().then((pos) => {
      if (pos) {
        windowStartPos.current = { x: pos.x, y: pos.y };
      }
    });

    const handleMouseMove = (ev: MouseEvent): void => {
      const dx = ev.screenX - dragStartPos.current.x;
      const dy = ev.screenY - dragStartPos.current.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        wasDragged.current = true;
        window.copilot.setPosition(
          windowStartPos.current.x + dx,
          windowStartPos.current.y + dy
        );
      }
    };

    const handleMouseUp = (): void => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleClick = useCallback(() => {
    if (wasDragged.current) return;
    toggleExpanded();
  }, [toggleExpanded]);

  const animationClass = {
    idle: 'animate-bob',
    processing: 'animate-thrust',
    permission: 'animate-pulse-amber',
    complete: 'animate-flash-green',
  }[spriteState];

  return (
    <div
      className={`cursor-pointer select-none ${animationClass}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(23, 23, 23, 0.9)',
        borderRadius: '12px',
        border: '1px solid rgba(64, 64, 64, 0.8)',
      }}
    >
      <span style={{ fontSize: 28, lineHeight: 1 }}>🚀</span>
    </div>
  );
}
