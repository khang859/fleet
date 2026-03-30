import React, { useEffect, useState, useRef } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { ChevronLeft } from 'lucide-react';
import { MASCOT_REGISTRY, DEFAULT_ANIMATIONS } from '../../../../shared/mascots';
import { getSpriteSheet } from '../assets/sprite-loader';
import type { SpriteAnimations } from '../../../../shared/types';

type PreviewState = 'idle' | 'processing' | 'permission' | 'complete';

const PREVIEW_STATES: PreviewState[] = ['idle', 'processing', 'permission', 'complete'];

function useAnimatedFrame(animations: SpriteAnimations, state: PreviewState): number {
  const frameRef = useRef(0);
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    frameRef.current = 0;
    setFrameIndex(animations[state].frames[0]);
    const anim = animations[state];
    const interval = 1000 / anim.fps;
    const timer = window.setInterval(() => {
      frameRef.current = (frameRef.current + 1) % anim.frames.length;
      setFrameIndex(anim.frames[frameRef.current]);
    }, interval);
    return () => window.clearInterval(timer);
  }, [animations, state]);

  return frameIndex;
}

function AnimationPreview({ mascotId }: { mascotId: string }): React.JSX.Element {
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const mascot = MASCOT_REGISTRY.find((m) => m.id === mascotId);
  const animations = mascot?.animations ?? DEFAULT_ANIMATIONS;
  const totalFrames = Math.max(...Object.values(animations).flatMap((a) => a.frames)) + 1;
  const frameIndex = useAnimatedFrame(animations, previewState);
  const sheet = getSpriteSheet(mascotId);
  const size = 80;

  return (
    <div className="flex flex-col items-center gap-2 px-3 py-3 border-b border-neutral-700">
      <span className="text-xs text-neutral-400">{mascot?.name ?? mascotId}</span>
      <div
        style={{
          width: size,
          height: size,
          backgroundImage: `url(${sheet})`,
          backgroundPosition: `-${frameIndex * size}px 0`,
          backgroundSize: `${size * totalFrames}px ${size}px`,
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated',
        }}
      />
      <div className="flex gap-1">
        {PREVIEW_STATES.map((s) => (
          <button
            key={s}
            onClick={() => setPreviewState(s)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              previewState === s
                ? 'bg-blue-500 text-white'
                : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MascotPicker(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);
  const selectedId = settings?.spriteSheet ?? 'officer';
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const previewId = hoveredId ?? selectedId;

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <Button variant="ghost" size="sm" onClick={() => setView('sessions')}>
          <ChevronLeft size={14} />
        </Button>
        <span className="text-sm font-medium text-neutral-200">Mascots</span>
      </div>

      <AnimationPreview mascotId={previewId} />

      <ScrollArea className="flex-1">
        <div className="px-3 py-2">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(60px,1fr))] gap-2">
            {MASCOT_REGISTRY.map((mascot) => {
              const isSelected = selectedId === mascot.id;
              const isHovered = hoveredId === mascot.id;
              const sheet = getSpriteSheet(mascot.id);
              const anims = mascot.animations ?? DEFAULT_ANIMATIONS;
              const totalFrames = Math.max(...Object.values(anims).flatMap((a) => a.frames)) + 1;
              return (
                <button
                  key={mascot.id}
                  onClick={() => void updateSettings({ spriteSheet: mascot.id })}
                  onMouseEnter={() => setHoveredId(mascot.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={`flex flex-col items-center gap-1 p-1.5 rounded border transition-colors ${
                    isSelected
                      ? 'border-blue-500 bg-blue-500/10'
                      : isHovered
                        ? 'border-blue-400/50 bg-blue-500/5'
                        : 'border-neutral-700 hover:border-neutral-500'
                  }`}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      backgroundImage: `url(${sheet})`,
                      backgroundPosition: `-${mascot.thumbnailFrame * 128 * (48 / 128)}px 0`,
                      backgroundSize: `${128 * totalFrames * (48 / 128)}px ${48}px`,
                      backgroundRepeat: 'no-repeat',
                      imageRendering: 'pixelated',
                    }}
                  />
                  <span className="text-xs text-neutral-300">{mascot.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
