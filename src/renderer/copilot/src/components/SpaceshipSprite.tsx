import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { getSpriteSheet } from '../assets/sprite-loader';
import { MASCOT_REGISTRY, DEFAULT_ANIMATIONS } from '../../../../shared/mascots';
import type { SpriteAnimations } from '../../../../shared/types';

const SPRITE_SIZE = 128;
const HEADER_SPRITE_SIZE = 96;
const DRAG_THRESHOLD = 4;

type SpaceshipSpriteProps = {
  mode?: 'floating' | 'header';
  teleportState?: 'idle' | 'out' | 'in';
  onToggle?: () => void;
};

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

function useSpriteAnimation(state: SpriteState, animations: SpriteAnimations): number {
  const frameRef = useRef(0);
  const timerRef = useRef(0);
  const [, forceRender] = useState(0);
  const prevState = useRef(state);

  if (prevState.current !== state) {
    prevState.current = state;
    frameRef.current = 0;
  }

  useEffect(() => {
    const anim = animations[state];
    const interval = 1000 / anim.fps;
    timerRef.current = window.setInterval(() => {
      frameRef.current = (frameRef.current + 1) % anim.frames.length;
      forceRender((n) => n + 1);
    }, interval);
    return () => window.clearInterval(timerRef.current);
  }, [state, animations]);

  const anim = animations[state];
  return anim.frames[frameRef.current % anim.frames.length];
}

export function SpaceshipSprite({
  mode = 'floating',
  teleportState = 'idle',
  onToggle,
}: SpaceshipSpriteProps): React.JSX.Element {
  const spriteState = useSpriteState();
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);
  const settings = useCopilotStore((s) => s.settings);
  const mascotId = settings?.spriteSheet ?? 'officer';
  const mascot = MASCOT_REGISTRY.find((m) => m.id === mascotId);
  const animations = mascot?.animations ?? DEFAULT_ANIMATIONS;
  const totalFrames = useMemo(
    () => Math.max(...Object.values(animations).flatMap((a) => a.frames)) + 1,
    [animations],
  );
  const frameIndex = useSpriteAnimation(spriteState, animations);
  const spriteSheet = getSpriteSheet(mascotId);

  const wasDragged = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (mode === 'header') return; // No dragging in header mode
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
  }, [mode]);

  const handleClick = useCallback(() => {
    if (mode === 'floating' && wasDragged.current) return;
    if (onToggle) {
      onToggle();
    } else {
      toggleExpanded();
    }
  }, [toggleExpanded, mode, onToggle]);

  const size = mode === 'header' ? HEADER_SPRITE_SIZE : SPRITE_SIZE;

  const animationClass = mode === 'floating' ? {
    idle: 'animate-bob',
    processing: 'animate-thrust',
    permission: 'animate-pulse-amber',
    complete: 'animate-flash-green',
  }[spriteState] : '';

  const teleportClass = teleportState === 'out'
    ? 'animate-teleport-out'
    : teleportState === 'in'
      ? 'animate-teleport-in'
      : '';

  return (
    <div
      className={`cursor-pointer select-none ${animationClass} ${teleportClass}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${spriteSheet})`,
        backgroundPosition: `-${frameIndex * size}px 0`,
        backgroundSize: `${size * totalFrames}px ${size}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  );
}
