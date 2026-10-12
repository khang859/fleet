import { useEffect, useRef, useState } from 'react';
import type { TerminalBackgroundSlideshow } from '../../../../shared/types';
import { toFleetImageUrl, toFleetMediaUrl } from '../../../../shared/path-platform';
import { backgroundMediaKind } from '../../../../shared/background-media';
import { releaseVideo } from '../../lib/background-video';

/**
 * A video in the grid, shown as a still: only its metadata is fetched, and the
 * time fragment makes Chromium paint that frame rather than leave the tile
 * empty until something plays.
 *
 * It holds a player only while the tile is on screen. Chromium allows a page a
 * limited number of them, and a long list would otherwise take them all - the
 * one the window's own background needs included.
 */
function VideoThumb(props: { path: string; title?: string }): React.JSX.Element {
  const { path, title } = props;
  const boxRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!onScreen || !video) return;
    video.src = `${toFleetMediaUrl(path)}#t=0.1`;
    return () => releaseVideo(video);
  }, [onScreen, path]);

  return (
    <span ref={boxRef} className="block w-full h-full" title={title}>
      {onScreen && (
        <video
          ref={videoRef}
          muted
          preload="metadata"
          tabIndex={-1}
          aria-hidden
          className="w-full h-full object-cover pointer-events-none"
        />
      )}
      <span
        aria-hidden
        className="absolute bottom-0.5 right-0.5 bg-black/60 text-white rounded px-1 text-[9px] leading-[14px] pointer-events-none"
      >
        ▶
      </span>
    </span>
  );
}

/** One file in the grid. The corner mark is what tells a video from a picture. */
function MediaThumb(props: { path: string; title?: string }): React.JSX.Element {
  const { path, title } = props;
  if (backgroundMediaKind(path) === 'video') return <VideoThumb path={path} title={title} />;
  return (
    <img
      src={toFleetImageUrl(path)}
      className="w-full h-full object-cover pointer-events-none"
      loading="lazy"
      draggable={false}
      alt=""
      title={title}
    />
  );
}

export function BackgroundThumbnails(props: {
  slideshow: TerminalBackgroundSlideshow;
  onRemoveFile?: (path: string) => void;
  onReorderFile?: (from: number, to: number) => void;
  maxVisible?: number;
}): React.JSX.Element | null {
  const { slideshow, onRemoveFile, onReorderFile, maxVisible = 8 } = props;

  const [folderImages, setFolderImages] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (slideshow.source !== 'folder') return;
    if (!slideshow.folderPath) return;

    setScanning(true);
    setFolderImages([]);

    let cancelled = false;
    void window.fleet.file.scanImageFolder(slideshow.folderPath).then((paths) => {
      if (cancelled) return;
      setFolderImages(paths);
      setScanning(false);
    });
    return () => {
      cancelled = true;
    };
  }, [slideshow.source, slideshow.folderPath]);

  if (slideshow.source === 'folder') {
    if (!slideshow.folderPath) return null;

    if (scanning) {
      return <p className="text-fleet-text-subtle text-xs">Scanning…</p>;
    }

    if (folderImages.length === 0) {
      return <p className="text-fleet-text-subtle text-xs">No images or videos found in folder.</p>;
    }

    return <ThumbnailGrid paths={folderImages} maxVisible={maxVisible} />;
  }

  // source === 'files'
  if (slideshow.filePaths.length === 0) return null;

  // The file list is the user's editable, ordered slideshow — show every image
  // (not the capped preview) so each can be removed and reordered.
  if (onRemoveFile && onReorderFile) {
    return (
      <EditableFileGrid
        paths={slideshow.filePaths}
        onRemoveFile={onRemoveFile}
        onReorderFile={onReorderFile}
      />
    );
  }

  return (
    <ThumbnailGrid
      paths={slideshow.filePaths}
      maxVisible={maxVisible}
      onRemoveFile={onRemoveFile}
    />
  );
}

function EditableFileGrid(props: {
  paths: string[];
  onRemoveFile: (path: string) => void;
  onReorderFile: (from: number, to: number) => void;
}): React.JSX.Element {
  const { paths, onRemoveFile, onReorderFile } = props;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const clearDrag = (): void => {
    setDragIndex(null);
    setOverIndex(null);
  };

  const drop = (to: number): void => {
    if (dragIndex !== null && dragIndex !== to) onReorderFile(dragIndex, to);
    clearDrag();
  };

  return (
    <div className="grid grid-cols-4 gap-1.5 max-h-[260px] overflow-y-auto pr-0.5">
      {paths.map((path, index) => {
        const filename = path.split('/').pop() ?? path;
        const isDragging = dragIndex === index;
        const isOver = overIndex === index && dragIndex !== index;
        return (
          <div
            key={path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              setDragIndex(index);
            }}
            onDragEnter={() => setOverIndex(index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(index)}
            onDragEnd={clearDrag}
            title={filename}
            className={`group relative aspect-[16/10] rounded overflow-hidden border cursor-grab active:cursor-grabbing transition ${
              isOver
                ? 'border-fleet-text-subtle ring-1 ring-fleet-text-subtle'
                : 'border-fleet-border-strong'
            } ${isDragging ? 'opacity-40' : ''}`}
          >
            <MediaThumb path={path} />
            <button
              type="button"
              onClick={() => onRemoveFile(path)}
              aria-label={`Remove ${filename}`}
              className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full w-4 h-4 text-[10px] leading-none flex items-center justify-center hover:bg-black/80"
            >
              ×
            </button>
            <div className="absolute bottom-0.5 left-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                disabled={index === 0}
                onClick={() => onReorderFile(index, index - 1)}
                aria-label={`Move ${filename} earlier`}
                className="bg-black/60 text-white rounded w-4 h-4 text-[11px] leading-none flex items-center justify-center hover:bg-black/80 disabled:opacity-30 disabled:cursor-default"
              >
                ‹
              </button>
              <button
                type="button"
                disabled={index === paths.length - 1}
                onClick={() => onReorderFile(index, index + 1)}
                aria-label={`Move ${filename} later`}
                className="bg-black/60 text-white rounded w-4 h-4 text-[11px] leading-none flex items-center justify-center hover:bg-black/80 disabled:opacity-30 disabled:cursor-default"
              >
                ›
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThumbnailGrid(props: {
  paths: string[];
  maxVisible: number;
  onRemoveFile?: (path: string) => void;
}): React.JSX.Element {
  const { paths, maxVisible, onRemoveFile } = props;

  const visible = paths.slice(0, maxVisible);
  const overflow = paths.length - maxVisible;
  const showOverflow = overflow > 0;

  // If overflow, replace the last visible slot with the +N tile
  const tiles = showOverflow ? visible.slice(0, maxVisible - 1) : visible;
  const remaining = showOverflow ? overflow + 1 : 0;

  return (
    <div className="grid grid-cols-4 gap-1.5">
      {tiles.map((path) => {
        const filename = path.split('/').pop() ?? path;
        return (
          <div
            key={path}
            className="relative aspect-[16/10] rounded overflow-hidden border border-fleet-border-strong"
          >
            <MediaThumb path={path} title={filename} />
            {onRemoveFile && (
              <button
                type="button"
                onClick={() => onRemoveFile(path)}
                aria-label={`Remove ${filename}`}
                className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full w-4 h-4 text-[10px] leading-none flex items-center justify-center hover:bg-black/80"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {showOverflow && (
        <div className="aspect-[16/10] rounded overflow-hidden border border-fleet-border-strong bg-fleet-surface-2 flex items-center justify-center">
          <span className="text-fleet-text-subtle text-xs">+{remaining}</span>
        </div>
      )}
    </div>
  );
}
