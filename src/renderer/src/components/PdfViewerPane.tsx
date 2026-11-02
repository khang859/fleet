import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './pdf-text-layer.css';
import type { PathContext } from '../../../shared/shell-profiles';
import type { RemoteFileRef } from '../../../shared/remote-ssh-types';
import { formatSize, getBasename } from '../lib/file-display';
import { createCancellation } from '../lib/cancellation';
import { PdfRangeTransport, type PdfReadError } from '../lib/pdf-range-transport';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// publicDir assets — absolute URLs resolved against the document so the pdf.js
// worker (which resolves relative URLs against itself) fetches them correctly
// in both dev (base '/') and packaged (base './') builds.
const CMAP_URL = new URL(`${import.meta.env.BASE_URL}pdfjs/cmaps/`, window.location.href).href;
const STANDARD_FONT_DATA_URL = new URL(
  `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  window.location.href
).href;
const WASM_URL = new URL(`${import.meta.env.BASE_URL}pdfjs/wasm/`, window.location.href).href;
const ICC_URL = new URL(`${import.meta.env.BASE_URL}pdfjs/iccs/`, window.location.href).href;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const ROTATION_STEP = 90;

const READ_ERROR_TEXT: Record<PdfReadError, string> = {
  changed: 'The file changed on disk.',
  failed: 'Failed to read PDF'
};

/** A page can have its own rotation in the file, so the user's turn adds to it. */
function rotatedViewport(page: PDFPageProxy, scale: number, rotation: number): PageViewport {
  return page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
}

type PdfViewerPaneProps = {
  filePath: string;
  pathContext?: PathContext;
  /** Set when `filePath` is the local cache copy of a remote PDF - the document
   *  renders from the cache, but the name shown must be the remote one. */
  remote?: RemoteFileRef;
};

export function PdfViewerPane({
  filePath,
  pathContext,
  remote
}: PdfViewerPaneProps): React.JSX.Element {
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
  const [rotation, setRotation] = useState(0);
  const [fileSize, setFileSize] = useState<number | null>(null);
  // Bumped by the Reload button so the load effect runs again on the same file.
  const [loadCount, setLoadCount] = useState(0);

  const filename = getBasename(remote?.path ?? filePath);

  // Load the document (stat first so missing files give a clear error rather
  // than an opaque pdf.js failure).
  useEffect(() => {
    const run = createCancellation();
    setLoading(true);
    setError(null);
    setNumPages(0);
    setPageNum(1);
    setZoom(1);
    setRotation(0);
    setFileSize(null);

    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    const load = async (): Promise<void> => {
      const stat = await window.fleet.file.stat(filePath, pathContext);
      if (run.isCancelled()) return;
      if (!stat.success || !stat.data || stat.data.size === 0) {
        setError('File not found or unreadable');
        setLoading(false);
        return;
      }
      setFileSize(stat.data.size);
      try {
        // Read over IPC, not by URL: pdf.js only fetches http(s), and Chromium
        // blocks its XHR fallback on a custom scheme, from any origin.
        const source = {
          path: filePath,
          pathContext,
          version: { size: stat.data.size, modifiedAt: stat.data.modifiedAt }
        };
        const range = new PdfRangeTransport(source, (readError) => {
          if (run.isCancelled()) return;
          setError(READ_ERROR_TEXT[readError]);
          setLoading(false);
        });
        loadingTask = pdfjs.getDocument({
          range,
          // Read only what the open page needs, not the rest in the background.
          disableAutoFetch: true,
          disableStream: true,
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONT_DATA_URL,
          wasmUrl: WASM_URL,
          iccUrl: ICC_URL
        });
        const doc = await loadingTask.promise;
        // The effect cleanup has already destroyed the loading task.
        if (run.isCancelled()) return;
        docRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch {
        if (run.isCancelled()) return;
        setError('Failed to load PDF');
        setLoading(false);
      }
    };
    void load();

    return () => {
      run.cancel();
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      void loadingTask?.destroy();
      docRef.current = null;
    };
  }, [filePath, pathContext, loadCount]);

  // Render the current page whenever page, zoom or rotation changes. Cancels any in-flight
  // render first and snaps to the new view with no transition.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading || error) return;
    const run = createCancellation();

    const render = async (): Promise<void> => {
      renderTaskRef.current?.cancel();
      // getPage fails when the document is destroyed or a read fails, and the
      // load effect already handles both.
      const page = await doc.getPage(pageNum).catch(() => null);
      if (!page) return;
      try {
        if (run.isCancelled()) return;
        const viewport = rotatedViewport(page, zoom, rotation);
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
        const task = page.render({ canvas, viewport, transform });
        renderTaskRef.current = task;
        try {
          await task.promise;
        } catch {
          // Render cancelled (page/zoom changed mid-render) — expected, ignore.
        }
        // The load effect destroys the document on a file change, before this
        // effect's own cleanup runs.
        if (run.isCancelled() || docRef.current !== doc) return;

        // Overlay a transparent text layer so the page text is selectable and
        // copyable. TextLayer sizes the container and its text from
        // --total-scale-factor, so that must equal the CSS scale (zoom and the
        // page's UserUnit, not the HiDPI outputScale).
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
          textLayerInstanceRef.current?.cancel();
          textLayerDiv.replaceChildren();
          textLayerDiv.style.setProperty('--total-scale-factor', String(zoom * page.userUnit));
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
      run.cancel();
      textLayerInstanceRef.current?.cancel();
    };
  }, [pageNum, zoom, rotation, loading, error, numPages]);

  const adjustZoom = useCallback((delta: number) => {
    setZoom((prev) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
  }, []);

  const fitToWidth = useCallback(async () => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container) return;
    const page = await doc.getPage(pageNum).catch(() => null);
    if (!page) return;
    try {
      const vp = rotatedViewport(page, 1, rotation);
      const avail = container.clientWidth - 32;
      setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / vp.width)));
    } finally {
      page.cleanup();
    }
  }, [pageNum, rotation]);

  const rotate = useCallback(() => {
    setRotation((prev) => (prev + ROTATION_STEP) % 360);
  }, []);

  const goPrev = useCallback(() => setPageNum((n) => Math.max(1, n - 1)), []);
  const goNext = useCallback(() => setPageNum((n) => Math.min(numPages, n + 1)), [numPages]);

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="flex flex-col h-full w-full bg-neutral-900">
      {/* Document viewport */}
      <div ref={containerRef} className="flex-1 overflow-auto relative flex justify-center">
        {error && <PdfErrorView message={error} onReload={() => setLoadCount((n) => n + 1)} />}
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
            <span className="font-mono min-w-12 px-1 text-center whitespace-nowrap text-neutral-400">
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
            <div className="w-px h-3.5 bg-neutral-700 mx-1" />
            <ToolbarButton onClick={rotate} title="Rotate Clockwise">
              <RotateCw size={12} />
            </ToolbarButton>
          </div>
        )}
      </div>
    </div>
  );
}

function PdfErrorView({
  message,
  onReload
}: {
  message: string;
  onReload: () => void;
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-neutral-400 text-sm">
      {message}
      <button
        className="text-neutral-200 text-xs px-3 py-1 rounded border border-neutral-700 hover:bg-white/10 hover:text-white transition-colors active:scale-[0.97]"
        onClick={onReload}
      >
        Reload
      </button>
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
