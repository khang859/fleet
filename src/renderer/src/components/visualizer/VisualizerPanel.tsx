import { useState, useCallback } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { SpaceCanvas } from './SpaceCanvas';

type VisualizerPanelProps = {
  onShipClick: (paneId: string) => void;
};

export function VisualizerPanel({ onShipClick }: VisualizerPanelProps) {
  const { isVisible, panelMode } = useVisualizerStore();
  const [drawerHeight, setDrawerHeight] = useState(200);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = drawerHeight;

    function onMove(moveEvent: PointerEvent) {
      const delta = startY - moveEvent.clientY;
      setDrawerHeight(Math.max(100, Math.min(600, startHeight + delta)));
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [drawerHeight]);

  if (!isVisible) return null;

  if (panelMode === 'drawer') {
    return (
      <div className="border-t border-neutral-800 bg-[#0a0a1a]" style={{ height: `${drawerHeight}px` }}>
        <div
          className="h-1 cursor-row-resize bg-neutral-800 hover:bg-blue-500 transition-colors"
          onPointerDown={handleResizeStart}
        />
        <div className="flex items-center justify-between px-3 py-1 border-b border-neutral-800">
          <span className="text-xs text-neutral-500 uppercase tracking-wider">Fleet Visualizer</span>
        </div>
        <div className="h-[calc(100%-32px)]">
          <SpaceCanvas onShipClick={onShipClick} />
        </div>
      </div>
    );
  }

  // Tab mode — full height
  return (
    <div className="flex-1 bg-[#0a0a1a]">
      <SpaceCanvas onShipClick={onShipClick} />
    </div>
  );
}
