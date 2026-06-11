import { useEffect, useState } from 'react';
import type { TerminalBackgroundSlideshow } from '../../../../shared/types';

export function BackgroundThumbnails(props: {
  slideshow: TerminalBackgroundSlideshow;
  onRemoveFile?: (path: string) => void;
  maxVisible?: number;
}): React.JSX.Element | null {
  const { slideshow, onRemoveFile, maxVisible = 8 } = props;

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
      return <p className="text-fleet-text-subtle text-xs">No images found in folder.</p>;
    }

    return <ThumbnailGrid paths={folderImages} maxVisible={maxVisible} />;
  }

  // source === 'files'
  if (slideshow.filePaths.length === 0) return null;

  return (
    <ThumbnailGrid
      paths={slideshow.filePaths}
      maxVisible={maxVisible}
      onRemoveFile={onRemoveFile}
    />
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
            <img
              src={encodeURI(`fleet-image://${path}`)}
              className="w-full h-full object-cover"
              loading="lazy"
              draggable={false}
              alt=""
              title={filename}
            />
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
