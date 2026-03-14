import { useRef, useEffect, useCallback, useState } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { Starfield } from './starfield';
import { ShipManager } from './ships';
import { SpaceRenderer } from './space-renderer';

type Tooltip = {
  x: number;
  y: number;
  label: string;
  tool: string;
  uptime: string;
};

type SpaceCanvasProps = {
  onShipClick: (paneId: string) => void;
};

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

const BG_COLOR = '#0a0a1a';

export function SpaceCanvas({ onShipClick }: SpaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starfieldRef = useRef<Starfield | null>(null);
  const shipManagerRef = useRef(new ShipManager());
  const spaceRendererRef = useRef(new SpaceRenderer());
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const { agents, isVisible } = useVisualizerStore();

  // Keep agents in a ref so the game loop doesn't restart on every IPC update
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

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

    // Initialize starfield on first visible render
    if (!starfieldRef.current) {
      starfieldRef.current = new Starfield(canvas.clientWidth, canvas.clientHeight);
    }

    const starfield = starfieldRef.current;
    const shipManager = shipManagerRef.current;
    const spaceRenderer = spaceRendererRef.current;

    function loop(timestamp: number) {
      const deltaMs = lastTimeRef.current ? timestamp - lastTimeRef.current : 16;
      lastTimeRef.current = timestamp;

      const dpr = window.devicePixelRatio || 1;
      const cw = canvas!.clientWidth;
      const ch = canvas!.clientHeight;

      // Update canvas resolution for DPI scaling
      const targetW = Math.round(cw * dpr);
      const targetH = Math.round(ch * dpr);
      if (canvas!.width !== targetW || canvas!.height !== targetH) {
        canvas!.width = targetW;
        canvas!.height = targetH;
        starfield.resize(cw, ch);
      }

      // Scale context for DPI, then render in CSS-pixel space
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Update systems (use ref to avoid stale closure)
      starfield.update(deltaMs);
      shipManager.update(agentsRef.current, deltaMs, cw, ch);
      spaceRenderer.updateTrails(shipManager.getShips(), deltaMs);

      // Clear and render
      ctx!.fillStyle = BG_COLOR;
      ctx!.fillRect(0, 0, cw, ch);

      starfield.render(ctx!);
      spaceRenderer.render(ctx!, shipManager.getShips());

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isVisible]);

  // Click handling
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

  // Hover handling for tooltips
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
          // Keep tooltip within canvas bounds
          const tooltipX = Math.min(x, rect.width - 160);
          const tooltipY = Math.max(y - 60, 0);
          setTooltip({
            x: tooltipX,
            y: tooltipY,
            label: ship.label,
            tool: ship.currentTool ?? 'none',
            uptime: formatUptime(ship.uptime),
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
          <div className="text-neutral-400">Tool: {tooltip.tool}</div>
          <div className="text-neutral-400">Uptime: {tooltip.uptime}</div>
        </div>
      )}
    </div>
  );
}
