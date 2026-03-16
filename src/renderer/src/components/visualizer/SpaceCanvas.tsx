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

export function SpaceCanvas({ onShipClick }: SpaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const cameraRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, following: null as string | null });
  const zoomRef = useRef(1);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const { isVisible } = useVisualizerStore();
  const { workspace } = useWorkspaceStore();

  // Derive agents from workspace tabs/panes and keep in ref
  const agentsRef = useRef<AgentVisualState[]>([]);
  agentsRef.current = workspaceToAgents(workspace.tabs);

  // Game loop — only restarts when visibility changes
  useEffect(() => {
    if (!isVisible) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!starfieldRef.current) {
      starfieldRef.current = new Starfield(canvas.clientWidth, canvas.clientHeight);
    }
    if (!bloomRef.current) {
      bloomRef.current = new BloomPass(canvas.clientWidth, canvas.clientHeight);
    }

    const starfield = starfieldRef.current;
    const shipManager = shipManagerRef.current;
    const spaceRenderer = spaceRendererRef.current;
    const shootingStars = shootingStarsRef.current;
    const nebula = nebulaRef.current;
    const aurora = auroraRef.current;
    const celestials = celestialsRef.current;
    const spaceWeather = spaceWeatherRef.current;
    const asteroidField = asteroidFieldRef.current;
    const bloom = bloomRef.current!;

    function loop(timestamp: number) {
      const deltaMs = lastTimeRef.current ? timestamp - lastTimeRef.current : 16;
      lastTimeRef.current = timestamp;

      const dpr = window.devicePixelRatio || 1;
      const cw = canvas!.clientWidth;
      const ch = canvas!.clientHeight;

      const targetW = Math.round(cw * dpr);
      const targetH = Math.round(ch * dpr);
      if (canvas!.width !== targetW || canvas!.height !== targetH) {
        canvas!.width = targetW;
        canvas!.height = targetH;
        starfield.resize(cw, ch);
        bloom.resize(cw, ch);
      }

      const zoom = zoomRef.current;
      ctx!.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);

      aurora.update(deltaMs);
      starfield.update(deltaMs);
      nebula.update(deltaMs, cw, ch);
      shootingStars.update(deltaMs, cw, ch);
      celestials.update(deltaMs, cw, ch);
      const workingCount = agentsRef.current.filter(a => a.state === 'working').length;
      spaceWeather.update(deltaMs, cw, ch, workingCount);
      shipManager.update(agentsRef.current, deltaMs, cw, ch);
      const hasPermissionNeeded = shipManager.getShips().some(s => s.state === 'needs-permission');
      asteroidField.update(deltaMs, cw, ch, hasPermissionNeeded);
      spaceRenderer.updateTrails(shipManager.getShips(), deltaMs);

      // Camera follow logic
      const camera = cameraRef.current;
      if (camera.following) {
        const ship = shipManager.getShips().find(s => s.paneId === camera.following);
        if (ship) {
          camera.targetX = ship.currentX - (cw / zoom) / 2;
          camera.targetY = ship.currentY - (ch / zoom) / 2;
        } else {
          camera.following = null;
          camera.targetX = 0;
          camera.targetY = 0;
        }
      }
      camera.x += (camera.targetX - camera.x) * 0.05;
      camera.y += (camera.targetY - camera.y) * 0.05;

      // BG fill (covers viewport regardless of camera)
      ctx!.fillStyle = getDayNightBackground();
      ctx!.fillRect(0, 0, cw / zoom, ch / zoom);

      // Apply camera transform for world-space rendering
      ctx!.translate(-camera.x, -camera.y);

      aurora.render(ctx!);
      nebula.render(ctx!);
      starfield.render(ctx!);
      shootingStars.render(ctx!);
      celestials.render(ctx!);
      asteroidField.render(ctx!);
      spaceWeather.render(ctx!);
      spaceRenderer.render(ctx!, shipManager.getShips());
      bloom.render(ctx!, cw, ch);

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isVisible]);

  // Soundscape cleanup
  useEffect(() => {
    return () => soundscapeRef.current.dispose();
  }, []);

  // Click handling — resolve ship paneId to either tab or pane
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
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
      const canvas = canvasRef.current;
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

  // Scroll-wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    zoomRef.current = Math.max(0.5, Math.min(2.0, zoomRef.current + e.deltaY * -0.001));
  }, []);

  // Hover tooltip
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
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
        ref={canvasRef}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        className="w-full h-full cursor-pointer"
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
