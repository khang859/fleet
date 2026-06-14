import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './pdf-text-layer.css';
import { toFleetPdfUrl } from '../../../shared/path-platform';
import type { PathContext } from '../../../shared/shell-profiles';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// publicDir assets — absolute URLs resolved against the document so the pdf.js
// worker (which resolves relative URLs against itself) fetches them correctly
// in both dev (base '/') and packaged (base './') builds.
const CMAP_URL = new URL(`${import.meta.env.BASE_URL}pdfjs/cmaps/`, window.location.href).href;
const STANDARD_FONT_DATA_URL = new URL(
  `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  window.location.href
).href;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function getBasename(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type PdfViewerPaneProps = {
  filePath: string;
  pathContext?: PathContext;
};

export function PdfViewerPane({ filePath, pathContext }: PdfViewerPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerInstanceRef = useRef<pdfjs.TextLayer | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fileSize, setFileSize] = useState<number | null>(null);

  const filename = getBasename(filePath);

  // Load the document (stat first so missing files give a clear error rather
  // than an opaque pdf.js failure).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    setPageNum(1);
    setZoom(1);
    setFileSize(null);

    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    const load = async (): Promise<void> => {
      const stat = await window.fleet.file.stat(filePath, pathContext);
      if (cancelled) return;
      if (!stat.success || !stat.data || stat.data.size === 0) {
        setError('File not found or unreadable');
        setLoading(false);
        return;
      }
      setFileSize(stat.data.size);
      try {
        loadingTask = pdfjs.getDocument({
          url: toFleetPdfUrl(filePath),
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONT_DATA_URL
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError('Failed to load PDF');
        setLoading(false);
      }
    };
    void load();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      void loadingTask?.destroy();
      const doc = docRef.current;
      docRef.current = null;
      if (doc) void doc.destroy();
    };
  }, [filePath, pathContext]);

  // Render the current page whenever page or zoom changes. Cancels any in-flight
  // render first and snaps to the new page/scale with no transition.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading || error) return;
    let cancelled = false;

    const render = async (): Promise<void> => {
      renderTaskRef.current?.cancel();
      const page = await doc.getPage(pageNum);
      try {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: zoom });
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
        const task = page.render({ canvasContext: ctx, viewport, transform });
        renderTaskRef.current = task;
        try {
          await task.promise;
        } catch {
          // Render cancelled (page/zoom changed mid-render) — expected, ignore.
        }
        if (cancelled) return;

        // Overlay a transparent text layer so the page text is selectable and
        // copyable. setLayerDimensions (inside TextLayer) sizes the container via
        // calc(var(--scale-factor) * pageWidth), so --scale-factor must equal the
        // CSS scale (zoom, not the HiDPI outputScale).
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
          textLayerInstanceRef.current?.cancel();
          textLayerDiv.replaceChildren();
          textLayerDiv.style.setProperty('--scale-factor', String(zoom));
          const textLayer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport
          });
          textLayerInstanceRef.current = textLayer;
          try {
            await textLayer.render();
          } catch {
            // Text-layer render cancelled (page/zoom changed) — expected, ignore.
          }
        }
      } finally {
        page.cleanup();
      }
    };
    void render();

    return () => {
      cancelled = true;
      textLayerInstanceRef.current?.cancel();
    };
  }, [pageNum, zoom, loading, error, numPages]);

  const adjustZoom = useCallback((delta: number) => {
    setZoom((prev) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
  }, []);

  const fitToWidth = useCallback(async () => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;
    const page = await doc.getPage(pageNum);
    try {
      const vp = page.getViewport({ scale: 1 });
      const avail = container.clientWidth - 32;
      setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / vp.width)));
    } finally {
      page.cleanup();
    }
  }, [pageNum]);

  const goPrev = useCallback(() => setPageNum((n) => Math.max(1, n - 1)), []);
  const goNext = useCallback(() => setPageNum((n) => Math.min(numPages, n + 1)), [numPages]);

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="flex flex-col h-full w-full bg-neutral-900">
      {/* Document viewport */}
      <div ref={containerRef} className="flex-1 overflow-auto relative flex justify-center">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-sm">
            {error}
          </div>
        )}
        {!error && loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-400 text-sm">
            <Loader2 className="animate-spin" size={16} />
            Loading…
          </div>
        )}
        {!error && (
          <div className="relative my-4 h-fit shadow-lg shadow-black/40">
            <canvas ref={canvasRef} className="block" />
            <div ref={textLayerRef} className="textLayer" />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300 truncate max-w-xs">{filename}</span>
        {fileSize !== null && <span className="text-neutral-500">{formatSize(fileSize)}</span>}
        {!error && numPages > 0 && (
          <div className="ml-auto flex items-center gap-0.5">
            <ToolbarButton onClick={goPrev} title="Previous Page" disabled={pageNum <= 1}>
              ‹
            </ToolbarButton>
            <span className="font-mono w-12 text-center text-neutral-400">
              {pageNum} / {numPages}
            </span>
            <ToolbarButton onClick={goNext} title="Next Page" disabled={pageNum >= numPages}>
              ›
            </ToolbarButton>
            <div className="w-px h-3.5 bg-neutral-700 mx-1" />
            <ToolbarButton onClick={() => adjustZoom(-ZOOM_STEP)} title="Zoom Out">
              −
            </ToolbarButton>
            <span className="font-mono w-10 text-center text-neutral-400">{zoomPercent}%</span>
            <ToolbarButton onClick={() => adjustZoom(ZOOM_STEP)} title="Zoom In">
              +
            </ToolbarButton>
            <div className="w-px h-3.5 bg-neutral-700 mx-1" />
            <ToolbarButton onClick={() => void fitToWidth()} title="Fit Width">
              Fit
            </ToolbarButton>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
  disabled
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      className="text-neutral-300 hover:text-white text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97] disabled:active:scale-100"
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
