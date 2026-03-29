import React, { useRef, useCallback, useState, useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { getSpriteSheet } from '../assets/sprite-loader';

const SPRITE_SIZE = 128;
const DRAG_THRESHOLD = 4;

type SpriteState = 'idle' | 'processing' | 'permission' | 'complete';

// Frame indices in the sprite sheet (each frame is 48px wide)
// Layout: idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)
const SPRITE_ANIMATIONS: Record<SpriteState, { frames: number[]; fps: number }> = {
  idle: { frames: [0, 1], fps: 2 },
  processing: { frames: [2, 3, 4], fps: 4 },
  permission: { frames: [5, 6], fps: 3 },
  complete: { frames: [7, 8], fps: 2 },
};

function useSpriteState(): SpriteState {
  const sessions = useCopilotStore((s) => s.sessions);
  if (sessions.length === 0) return 'idle';
  const hasPermission = sessions.some((s) => s.pendingPermissions.length > 0);
  if (hasPermission) return 'permission';
  const hasProcessing = sessions.some((s) => s.phase === 'processing' || s.phase === 'compacting');
  if (hasProcessing) return 'processing';
  return 'idle';
}

function useSpriteAnimation(state: SpriteState): number {
  const frameRef = useRef(0);
  const timerRef = useRef(0);
  const [, forceRender] = useState(0);
  const prevState = useRef(state);

  if (prevState.current !== state) {
    prevState.current = state;
    frameRef.current = 0;
  }

  useEffect(() => {
    const anim = SPRITE_ANIMATIONS[state];
    const interval = 1000 / anim.fps;
    timerRef.current = window.setInterval(() => {
      frameRef.current = (frameRef.current + 1) % anim.frames.length;
      forceRender((n) => n + 1);
    }, interval);
    return () => window.clearInterval(timerRef.current);
  }, [state]);

  const anim = SPRITE_ANIMATIONS[state];
  return anim.frames[frameRef.current % anim.frames.length];
}

export function SpaceshipSprite(): React.JSX.Element {
  const spriteState = useSpriteState();
  const frameIndex = useSpriteAnimation(spriteState);
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);
  const settings = useCopilotStore((s) => s.settings);
  const spriteSheet = getSpriteSheet(settings?.spriteSheet ?? 'officer');

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
        backgroundImage: `url(${spriteSheet})`,
        backgroundPosition: `-${frameIndex * SPRITE_SIZE}px 0`,
        backgroundSize: `${SPRITE_SIZE * 9}px ${SPRITE_SIZE}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  );
}
