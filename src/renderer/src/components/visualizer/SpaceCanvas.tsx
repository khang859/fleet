import { useRef, useEffect, useCallback, useState } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { useWorkspaceStore, collectPaneIds } from '../../store/workspace-store';
import { Starfield } from './starfield';
import { ShipManager } from './ships';
import { SpaceRenderer } from './space-renderer';
import { ShootingStarSystem } from './shooting-stars';
import { NebulaSystem } from './nebula';
import { AuroraBands } from './aurora';
import { CelestialBodies } from './celestials';
import { BloomPass } from './bloom';
import { SpaceWeather } from './space-weather';
import { AsteroidField } from './asteroids';
import { AmbientSoundscape } from './ambient-sound';
import { loadSpriteSheet } from './sprite-loader';
import type { AgentVisualState } from '../../../../shared/types';

type Tooltip = {
  x: number;
  y: number;
  label: string;
  panes: string;
};

type SpaceCanvasProps = {
  onShipClick: (paneId: string) => void;
};

function getDayNightBackground(): string {
  const hour = new Date().getHours();
  // Hour-to-color lookup: subtle dark space tints throughout the day
  const colors: Record<number, string> = {
    0: '#0a0a1a', 1: '#0a0a1a', 2: '#0a0a1a', 3: '#0a0a1a', 4: '#0a0a1a', 5: '#0a0a1a',
    6: '#120a1a', 7: '#120a1a', 8: '#120a1a',
    9: '#0f0e22', 10: '#0f0e22', 11: '#0f0e22', 12: '#0f0e22',
    13: '#0f0e22', 14: '#0f0e22', 15: '#0f0e22', 16: '#0f0e22',
    17: '#1a100f', 18: '#1a100f', 19: '#1a100f',
    20: '#0d0a1a', 21: '#0d0a1a', 22: '#0d0a1a', 23: '#0d0a1a',
  };
  return colors[hour] ?? '#0a0a1a';
}

/** Convert workspace tabs/panes into AgentVisualState[] for the ship manager.
 *  Each tab = parent ship. Each pane in the tab = trailing subagent ship. */
function workspaceToAgents(tabs: { id: string; label: string; splitRoot: import('../../../../shared/types').PaneNode }[]): AgentVisualState[] {
  return tabs.map((tab) => {
    const paneIds = collectPaneIds(tab.splitRoot);
    return {
      paneId: tab.id,
      label: tab.label,
      state: 'idle' as const,
      subAgents: paneIds.length > 1
        ? paneIds.map((pid) => ({
            paneId: pid,
            label: pid.slice(0, 8),
            state: 'idle' as const,
            subAgents: [],
            uptime: 0,
          }))
        : [],
      uptime: 0,
    };
  });
}

function createThrottledLoop(
  targetFps: number,
  onFrame: (deltaMs: number, timestamp: number) => void,
): { start: () => void; stop: () => void } {
  const interval = 1000 / targetFps;
  let animFrame = 0;
  let lastTime = 0;
  let accumulated = 0;

  function loop(timestamp: number) {
    const rawDelta = lastTime ? timestamp - lastTime : 0;
    lastTime = timestamp;
    const delta = Math.min(rawDelta, interval * 2);
    accumulated += delta;

    if (accumulated >= interval) {
      onFrame(accumulated, timestamp);
      accumulated %= interval;
    }

    animFrame = requestAnimationFrame(loop);
  }

  return {
    start() {
      lastTime = 0;
      accumulated = 0;
      animFrame = requestAnimationFrame(loop);
    },
    stop() {
      cancelAnimationFrame(animFrame);
    },
  };
}

function sizeCanvas(canvas: HTMLCanvasElement): { w: number; h: number } {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  return { w: cw, h: ch };
}

export function SpaceCanvas({ onShipClick }: SpaceCanvasProps) {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const midCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement>(null);
  const starfieldRef = useRef<Starfield | null>(null);
  const shipManagerRef = useRef(new ShipManager());
  const spaceRendererRef = useRef(new SpaceRenderer());
  const shootingStarsRef = useRef(new ShootingStarSystem());
  const nebulaRef = useRef(new NebulaSystem());
  const auroraRef = useRef(new AuroraBands());
  const celestialsRef = useRef(new CelestialBodies());
  const spaceWeatherRef = useRef(new SpaceWeather());
  const asteroidFieldRef = useRef(new AsteroidField());
  const bloomRef = useRef<BloomPass | null>(null);
  const soundscapeRef = useRef(new AmbientSoundscape());
  const cameraRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, following: null as string | null });
  const zoomRef = useRef(1);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const { isVisible } = useVisualizerStore();
  const { workspace } = useWorkspaceStore();

  // Derive agents from workspace tabs/panes and keep in ref
  const agentsRef = useRef<AgentVisualState[]>([]);
  agentsRef.current = workspaceToAgents(workspace.tabs);

  // Background loop (10fps) — aurora + nebula + bg fill
  useEffect(() => {
    if (!isVisible) return;
    const canvas = bgCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const aurora = auroraRef.current;
    const nebula = nebulaRef.current;

    const loop = createThrottledLoop(10, (deltaMs) => {
      const { w, h } = sizeCanvas(canvas);
      const zoom = zoomRef.current;
      const vw = w / zoom;
      const vh = h / zoom;
      ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

      aurora.update(deltaMs);
      nebula.update(deltaMs, vw, vh);

      const camera = cameraRef.current;
      ctx.fillStyle = getDayNightBackground();
      ctx.fillRect(0, 0, vw, vh);
      ctx.translate(-camera.x, -camera.y);

      aurora.render(ctx, vw, vh);
      nebula.render(ctx);
    });

    loop.start();
    return () => loop.stop();
  }, [isVisible]);

  // Mid loop (30fps) — starfield + shooting stars + celestials + asteroids
  useEffect(() => {
    if (!isVisible) return;
    const canvas = midCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!starfieldRef.current) {
      starfieldRef.current = new Starfield(canvas.clientWidth, canvas.clientHeight);
    }
    loadSpriteSheet();

    const starfield = starfieldRef.current;
    const shootingStars = shootingStarsRef.current;
    const celestials = celestialsRef.current;
    const asteroidField = asteroidFieldRef.current;

    const loop = createThrottledLoop(30, (deltaMs) => {
      const { w, h } = sizeCanvas(canvas);
      const zoom = zoomRef.current;
      const vw = w / zoom;
      const vh = h / zoom;
      ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

      if (starfield.getWidth() !== Math.ceil(vw) || starfield.getHeight() !== Math.ceil(vh)) {
        starfield.resize(Math.ceil(vw), Math.ceil(vh));
      }

      starfield.update(deltaMs);
      shootingStars.update(deltaMs, vw, vh);
      celestials.update(deltaMs, vw, vh);
      const hasPermissionNeeded = shipManagerRef.current.getShips().some(s => s.state === 'needs-permission');
      asteroidField.update(deltaMs, vw, vh, hasPermissionNeeded);

      const camera = cameraRef.current;
      ctx.clearRect(0, 0, vw, vh);
      ctx.translate(-camera.x, -camera.y);

      starfield.render(ctx);
      shootingStars.render(ctx);
      celestials.render(ctx);
      asteroidField.render(ctx);
    });

    loop.start();
    return () => loop.stop();
  }, [isVisible]);

  // Active loop (30fps) — ships + space weather + bloom + trails
  useEffect(() => {
    if (!isVisible) return;
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const shipManager = shipManagerRef.current;
    const spaceRenderer = spaceRendererRef.current;
    const spaceWeather = spaceWeatherRef.current;
    const bloom = bloomRef.current ?? new BloomPass();
    if (!bloomRef.current) bloomRef.current = bloom;

    const loop = createThrottledLoop(30, (deltaMs) => {
      const { w, h } = sizeCanvas(canvas);
      const zoom = zoomRef.current;
      const vw = w / zoom;
      const vh = h / zoom;
      ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

      let workingCount = 0;
      for (const a of agentsRef.current) if (a.state === 'working') workingCount++;
      spaceWeather.update(deltaMs, vw, vh, workingCount);
      shipManager.update(agentsRef.current, deltaMs, vw, vh);
      spaceRenderer.updateTrails(shipManager.getShips(), deltaMs);

      // Camera follow logic
      const camera = cameraRef.current;
      if (camera.following) {
        const ship = shipManager.getShips().find(s => s.paneId === camera.following);
        if (ship) {
          camera.targetX = ship.currentX - vw / 2;
          camera.targetY = ship.currentY - vh / 2;
        } else {
          camera.following = null;
          camera.targetX = 0;
          camera.targetY = 0;
        }
      }
      camera.x += (camera.targetX - camera.x) * 0.05;
      camera.y += (camera.targetY - camera.y) * 0.05;

      ctx.clearRect(0, 0, vw, vh);
      ctx.translate(-camera.x, -camera.y);

      spaceWeather.render(ctx);
      bloom.renderShipGlow(ctx, shipManager.getShips());
      spaceRenderer.render(ctx, shipManager.getShips());
    });

    loop.start();
    return () => loop.stop();
  }, [isVisible]);

  // Soundscape cleanup
  useEffect(() => {
    return () => soundscapeRef.current.dispose();
  }, []);

  // Click handling — resolve ship paneId to either tab or pane
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = activeCanvasRef.current;
      if (!canvas) return;

      // Initialize ambient soundscape on first click (requires user gesture)
      const soundscape = soundscapeRef.current;
      if (!soundscape.getIsRunning()) {
        soundscape.init().then(() => soundscape.setVolume(0.3));
      }

      const rect = canvas.getBoundingClientRect();
      const camera = cameraRef.current;
      const zoom = zoomRef.current;
      const x = (e.clientX - rect.left) / zoom + camera.x;
      const y = (e.clientY - rect.top) / zoom + camera.y;

      const hit = shipManagerRef.current.hitTest(x, y, canvas.clientWidth, canvas.clientHeight);
      if (hit) {
        onShipClick(hit);
      } else {
        cameraRef.current.following = null;
        cameraRef.current.targetX = 0;
        cameraRef.current.targetY = 0;
      }
    },
    [onShipClick],
  );

  // Double-click to follow a ship
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = activeCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const camera = cameraRef.current;
      const zoom = zoomRef.current;
      const x = (e.clientX - rect.left) / zoom + camera.x;
      const y = (e.clientY - rect.top) / zoom + camera.y;
      const hit = shipManagerRef.current.hitTest(x, y, canvas.clientWidth, canvas.clientHeight);
      if (hit) {
        camera.following = hit;
      }
    },
    [],
  );

  // Scroll-wheel zoom — native listener to allow { passive: false }
  useEffect(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      zoomRef.current = Math.max(0.5, Math.min(2.0, zoomRef.current + e.deltaY * -0.001));
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // Hover tooltip
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = activeCanvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const camera = cameraRef.current;
      const zoom = zoomRef.current;
      const x = (e.clientX - rect.left) / zoom + camera.x;
      const y = (e.clientY - rect.top) / zoom + camera.y;

      const hit = shipManagerRef.current.hitTest(x, y, canvas.clientWidth, canvas.clientHeight);
      if (hit) {
        const ship = shipManagerRef.current.getShips().find((s) => s.paneId === hit);
        if (ship) {
          // Use screen-space coordinates for tooltip positioning
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          const tooltipX = Math.min(screenX, rect.width - 160);
          const tooltipY = Math.max(screenY - 60, 0);

          const paneCount = ship.isSubAgent ? undefined :
            agentsRef.current.find((a) => a.paneId === hit)?.subAgents.length;

          setTooltip({
            x: tooltipX,
            y: tooltipY,
            label: ship.label,
            panes: ship.isSubAgent ? 'pane' : `${(paneCount ?? 0) + 1} pane${(paneCount ?? 0) + 1 !== 1 ? 's' : ''}`,
          });
          return;
        }
      }
      setTooltip(null);
    },
    [],
  );

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={bgCanvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ imageRendering: 'pixelated', pointerEvents: 'none' }}
      />
      <canvas
        ref={midCanvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ imageRendering: 'pixelated', pointerEvents: 'none' }}
      />
      <canvas
        ref={activeCanvasRef}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        className="absolute inset-0 w-full h-full cursor-pointer"
        style={{ imageRendering: 'pixelated' }}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white shadow-lg z-10"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-medium">{tooltip.label}</div>
          <div className="text-neutral-400">{tooltip.panes}</div>
        </div>
      )}
    </div>
  );
}
