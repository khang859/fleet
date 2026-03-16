import { useRef, useEffect, useCallback, useState } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { useWorkspaceStore, collectPaneIds } from '../../store/workspace-store';
import { Starfield } from './starfield';
import { ShipManager } from './ships';
import { SpaceRenderer } from './space-renderer';
import { ShootingStarSystem } from './shooting-stars';
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

const BG_COLOR = '#0a0a1a';

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
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
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

    const starfield = starfieldRef.current;
    const shipManager = shipManagerRef.current;
    const spaceRenderer = spaceRendererRef.current;
    const shootingStars = shootingStarsRef.current;

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
      }

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      starfield.update(deltaMs);
      shootingStars.update(deltaMs, cw, ch);
      shipManager.update(agentsRef.current, deltaMs, cw, ch);
      spaceRenderer.updateTrails(shipManager.getShips(), deltaMs);

      ctx!.fillStyle = BG_COLOR;
      ctx!.fillRect(0, 0, cw, ch);

      starfield.render(ctx!);
      shootingStars.render(ctx!);
      spaceRenderer.render(ctx!, shipManager.getShips());

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isVisible]);

  // Click handling — resolve ship paneId to either tab or pane
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = shipManagerRef.current.hitTest(x, y, canvas.clientWidth, canvas.clientHeight);
      if (hit) {
        onShipClick(hit);
      }
    },
    [onShipClick],
  );

  // Hover tooltip
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = shipManagerRef.current.hitTest(x, y, canvas.clientWidth, canvas.clientHeight);
      if (hit) {
        const ship = shipManagerRef.current.getShips().find((s) => s.paneId === hit);
        if (ship) {
          const tooltipX = Math.min(x, rect.width - 160);
          const tooltipY = Math.max(y - 60, 0);

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
