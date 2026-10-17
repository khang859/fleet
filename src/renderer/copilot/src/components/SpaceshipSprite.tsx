import type React from 'react';
import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { getSpriteSheet } from '../assets/sprite-loader';
import { MASCOT_REGISTRY, DEFAULT_ANIMATIONS } from '../../../../shared/mascots';
import type { SpriteAnimations } from '../../../../shared/types';
import { spriteStateFor, type SpriteState } from '../lib/sessions';
import { needsUser } from '../../../../shared/claude-sessions';

const SPRITE_SIZE = 128;
const HEADER_SPRITE_SIZE = 96;
const DRAG_THRESHOLD = 4;

type SpaceshipSpriteProps = {
  mode?: 'floating' | 'header';
  teleportState?: 'idle' | 'out' | 'in';
  onToggle?: () => void;
};

function useSpriteState(): SpriteState {
  const sessions = useCopilotStore((s) => s.sessions);
  const celebrating = useCopilotStore((s) => s.celebrating);
  return spriteStateFor(sessions, celebrating);
}

/** How the mascot names itself to screen readers: who needs you, and what a press does. */
function mascotLabel(waitingCount: number, mode: 'floating' | 'header'): string {
  const who =
    waitingCount === 0
      ? ''
      : `, ${waitingCount} ${waitingCount === 1 ? 'session needs' : 'sessions need'} you`;
  return `Fleet Copilot${who}. ${mode === 'floating' ? 'Open' : 'Close'} panel`;
}

/** Lets a key press on a role="button" element act like a click, as a real button does. */
function pressOnEnterOrSpace(press: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    press();
  };
}

/** The amber count of sessions that need the user, on the floating mascot. */
function WaitingBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count === 0) return null;
  return (
    <span
      aria-hidden
      className="absolute top-2 right-2 min-w-5 h-5 px-1 rounded-full bg-amber-500 text-neutral-950 text-[11px] font-bold leading-5 text-center shadow-md ring-2 ring-neutral-950/70"
    >
      {count}
    </span>
  );
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
  onToggle
}: SpaceshipSpriteProps): React.JSX.Element {
  const spriteState = useSpriteState();
  const waitingCount = useCopilotStore((s) => s.sessions.filter(needsUser).length);
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);
  const settings = useCopilotStore((s) => s.settings);
  const mascotId = settings?.spriteSheet ?? 'officer';
  const mascot = MASCOT_REGISTRY.find((m) => m.id === mascotId);
  const animations = mascot?.animations ?? DEFAULT_ANIMATIONS;
  const totalFrames = useMemo(
    () => Math.max(...Object.values(animations).flatMap((a) => a.frames)) + 1,
    [animations]
  );
  const frameIndex = useSpriteAnimation(spriteState, animations);
  const spriteSheet = getSpriteSheet(mascotId);

  const wasDragged = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode === 'header') return; // No dragging in header mode
      wasDragged.current = false;
      dragStartPos.current = { x: e.screenX, y: e.screenY };

      void window.copilot.getPosition().then((pos) => {
        if (pos) {
          windowStartPos.current = { x: pos.x, y: pos.y };
        }
      });

      const handleMouseMove = (ev: MouseEvent): void => {
        const dx = ev.screenX - dragStartPos.current.x;
        const dy = ev.screenY - dragStartPos.current.y;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          wasDragged.current = true;
          void window.copilot.setPosition(
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
    },
    [mode]
  );

  const handleClick = useCallback(() => {
    if (mode === 'floating' && wasDragged.current) return;
    if (onToggle) {
      onToggle();
    } else {
      toggleExpanded();
    }
  }, [toggleExpanded, mode, onToggle]);

  const size = mode === 'header' ? HEADER_SPRITE_SIZE : SPRITE_SIZE;

  const animationClass =
    mode === 'floating'
      ? {
          idle: 'animate-bob',
          processing: 'animate-thrust',
          permission: 'animate-pulse-amber',
          complete: 'animate-flash-green'
        }[spriteState]
      : '';

  const teleportClass =
    teleportState === 'out'
      ? 'animate-teleport-out'
      : teleportState === 'in'
        ? 'animate-teleport-in'
        : '';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={mascotLabel(waitingCount, mode)}
      className={`relative cursor-pointer select-none outline-none ${animationClass} ${teleportClass}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onKeyDown={pressOnEnterOrSpace(handleClick)}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${spriteSheet})`,
        backgroundPosition: `-${frameIndex * size}px 0`,
        backgroundSize: `${size * totalFrames}px ${size}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated'
      }}
    >
      {mode === 'floating' && <WaitingBadge count={waitingCount} />}
    </div>
  );
}
