import { useRef, useState, useEffect, useCallback } from 'react';

function getBasename(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.15;

type ImageViewerPaneProps = {
  filePath: string;
};

export function ImageViewerPane({ filePath }: ImageViewerPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isFit, setIsFit] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const dragAnchor = useRef({ x: 0, y: 0 });
  const offsetRef = useRef({ x: 0, y: 0 });
  const isFitRef = useRef(true);
  const zoomRef = useRef(1);

  // Keep refs in sync
  useEffect(() => { offsetRef.current = offset; }, [offset]);
  useEffect(() => { isFitRef.current = isFit; }, [isFit]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const filename = getBasename(filePath);

  // Load image as blob URL via IPC
  useEffect(() => {
    let blobUrl: string | null = null;
    setImageSrc(null);
    setError(null);
    setDimensions(null);
    setFileSize(null);
    setIsFit(true);
    setOffset({ x: 0, y: 0 });

    window.fleet.file.readBinary(filePath).then((result) => {
      if (!result.success || !result.data) {
        setError(result.error || 'Failed to load image');
        return;
      }
      const { base64, mimeType } = result.data;
      const byteChars = atob(base64);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([byteArray], { type: mimeType });
      blobUrl = URL.createObjectURL(blob);
      setImageSrc(blobUrl);
    });

    window.fleet.file.stat(filePath).then((result) => {
      if (result.success && result.data) setFileSize(result.data.size);
    });

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [filePath]);

  // Calculate fit zoom (scale to fill pane without cropping)
  const getFitZoom = useCallback((): number => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img || !img.naturalWidth || !img.naturalHeight) return 1;
    const { width: cw, height: ch } = container.getBoundingClientRect();
    const availW = cw - 16;
    const availH = ch - 16;
    return Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
  }, []);

  const applyFit = useCallback(() => {
    const fz = getFitZoom();
    setZoom(fz);
    setOffset({ x: 0, y: 0 });
    setIsFit(true);
  }, [getFitZoom]);

  // On image load: record dimensions and apply fit
  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    applyFit();
  }, [applyFit]);

  // Adjust zoom by delta, clamped
  const adjustZoom = useCallback((delta: number) => {
    setZoom(prev => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
    setIsFit(false);
  }, []);

  // Wheel zoom (non-passive native listener)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      setZoom(prev => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
      setIsFit(false);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // Double-click: toggle fit ↔ 100%
  const handleDoubleClick = useCallback(() => {
    if (isFitRef.current) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setIsFit(false);
    } else {
      applyFit();
    }
  }, [applyFit]);

  // Pan: mousedown start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isFitRef.current) return;
    e.preventDefault();
    dragAnchor.current = {
      x: e.clientX - offsetRef.current.x,
      y: e.clientY - offsetRef.current.y,
    };
    setIsDragging(true);
  }, []);

  // Pan: mousemove / mouseup via document listeners
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging) return;
      setOffset({
        x: e.clientX - dragAnchor.current.x,
        y: e.clientY - dragAnchor.current.y,
      });
    };
    const onUp = () => setIsDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  // Refit on container resize when in fit mode
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (isFitRef.current) applyFit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyFit]);

  // Keyboard shortcuts (active when pane is hovered)
  useEffect(() => {
    if (!isHovered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '0') applyFit();
      else if (e.key === '+' || e.key === '=') adjustZoom(ZOOM_STEP);
      else if (e.key === '-') adjustZoom(-ZOOM_STEP);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isHovered, applyFit, adjustZoom]);

  const zoomPercent = Math.round(zoom * 100);
  const cursor = isFit ? 'default' : isDragging ? 'grabbing' : 'grab';

  return (
    <div
      className="flex flex-col h-full w-full bg-neutral-900 select-none"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image viewport */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        style={{
          backgroundImage:
            'linear-gradient(45deg, #1c1c1c 25%, transparent 25%), ' +
            'linear-gradient(-45deg, #1c1c1c 25%, transparent 25%), ' +
            'linear-gradient(45deg, transparent 75%, #1c1c1c 75%), ' +
            'linear-gradient(-45deg, transparent 75%, #1c1c1c 75%)',
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
          backgroundColor: '#111',
          cursor,
        }}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-sm">
            {error}
          </div>
        )}

        {imageSrc && (
          <img
            ref={imgRef}
            src={imageSrc}
            alt={filename}
            onLoad={handleImageLoad}
            draggable={false}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              maxWidth: 'none',
              imageRendering: zoom > 3 ? 'pixelated' : 'auto',
              pointerEvents: 'none',
            }}
          />
        )}

        {/* Zoom indicator */}
        {imageSrc && (
          <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-0.5 rounded pointer-events-none font-mono">
            {zoomPercent}%
          </div>
        )}

        {/* Floating toolbar */}
        {isHovered && imageSrc && (
          <div className="absolute top-2 right-2 flex items-center gap-0.5 bg-black/70 backdrop-blur-sm border border-white/10 rounded px-1.5 py-1">
            <ToolbarButton onClick={() => adjustZoom(ZOOM_STEP)} title="Zoom In (+)">+</ToolbarButton>
            <ToolbarButton onClick={() => adjustZoom(-ZOOM_STEP)} title="Zoom Out (−)">−</ToolbarButton>
            <div className="w-px h-3.5 bg-neutral-600 mx-0.5" />
            <ToolbarButton onClick={applyFit} title="Fit to Window (0)">Fit</ToolbarButton>
            <ToolbarButton
              onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); setIsFit(false); }}
              title="Actual Size (1:1)"
            >
              1:1
            </ToolbarButton>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300 truncate max-w-xs">{filename}</span>
        {dimensions && (
          <span className="text-neutral-500">{dimensions.w} × {dimensions.h}</span>
        )}
        {fileSize !== null && (
          <span className="text-neutral-500">{formatSize(fileSize)}</span>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      className="text-neutral-300 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
