import { useEffect, useRef, useState } from 'react';
import { Music } from 'lucide-react';
import { isAudioFilePath } from '../../../shared/file-open';
import { toFleetMediaUrl } from '../../../shared/path-platform';
import type { PathContext } from '../../../shared/shell-profiles';
import type { RemoteFileRef } from '../../../shared/remote-ssh-types';
import { formatDuration, formatSize, getBasename } from '../lib/file-display';
import { MEDIA_SEEK_SECONDS, mediaKeyCommand } from '../lib/media-keys';

type MediaViewerPaneProps = {
  filePath: string;
  pathContext?: PathContext;
  /** Set when `filePath` is the local cache copy of a remote file - it plays
   *  from the cache, but the name shown must be the remote one. */
  remote?: RemoteFileRef;
};

/** `width` and `height` are 0 when the file has no picture to show. */
type MediaInfo = { width: number; height: number; duration: number };

export function MediaViewerPane({
  filePath,
  pathContext,
  remote
}: MediaViewerPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  const filename = getBasename(remote?.path ?? filePath);
  const isAudioFile = isAudioFilePath(filePath);
  // Until the metadata says otherwise, the extension is the best guess.
  const hasPicture = info ? info.width > 0 : !isAudioFile;

  useEffect(() => {
    setFailed(false);
    setInfo(null);
    setFileSize(null);

    void window.fleet.file.stat(filePath, pathContext).then((result) => {
      if (result.success && result.data) setFileSize(result.data.size);
    });
  }, [filePath, pathContext]);

  // Every open tab stays mounted behind `display: none`, where a file would
  // carry on playing unseen. Leaving the screen pauses it; the element keeps
  // its position, so coming back picks up where it stopped.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) videoRef.current?.pause();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const container = containerRef.current;
      // Every open player stays mounted; only the one on screen takes the keys.
      if (e.defaultPrevented || !container?.offsetParent) return;
      // A key aimed at something else - an input, a button, a menu, a terminal
      // in the next split - is not the player's to take.
      const focused = document.activeElement;
      if (focused && focused !== document.body && !container.contains(focused)) return;
      const video = videoRef.current;
      const command = mediaKeyCommand(e);
      if (!video || !command) return;
      e.preventDefault();
      switch (command) {
        case 'toggle':
          // play() rejects when a pause interrupts it, which is not an error here.
          if (video.paused) video.play().catch(() => {});
          else video.pause();
          break;
        case 'seek-back':
          video.currentTime = Math.max(0, video.currentTime - MEDIA_SEEK_SECONDS);
          break;
        case 'seek-forward':
          // `duration` is NaN until the metadata is in, and a NaN time throws.
          video.currentTime = Math.min(video.duration || 0, video.currentTime + MEDIA_SEEK_SECONDS);
          break;
        case 'mute':
          video.muted = !video.muted;
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleLoadedMetadata = (): void => {
    const video = videoRef.current;
    if (!video) return;
    setInfo({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex flex-col h-full w-full bg-neutral-900 select-none outline-none"
    >
      <div className="flex-1 min-h-0 relative bg-black flex flex-col items-center justify-center gap-4 px-6">
        {failed ? (
          <div className="flex flex-col gap-1 text-center text-sm text-neutral-400">
            <div>This file can&apos;t be played</div>
            <div className="text-xs text-neutral-500">
              Fleet plays video (mp4, mov, m4v, webm, mkv) and audio (mp3, m4a, aac, wav, flac, ogg)
              files, when the codec inside is one Chromium supports.
            </div>
          </div>
        ) : (
          <>
            {!hasPicture && (
              <>
                <Music size={48} strokeWidth={1.5} className="text-neutral-700" />
                {/* A video container Chromium can open with a picture codec it
                    cannot decode loads fine and plays its sound over nothing. */}
                {!isAudioFile && (
                  <div className="text-xs text-neutral-500">
                    No picture Fleet can show - playing the sound only
                  </div>
                )}
              </>
            )}
            {/* A <video> plays sound-only files too, with the same controls.
                With no picture it shrinks to its control bar. */}
            <video
              ref={videoRef}
              src={toFleetMediaUrl(filePath)}
              controls
              className={
                hasPicture
                  ? 'absolute inset-0 h-full w-full object-contain outline-none'
                  : 'h-[54px] w-full max-w-xl outline-none'
              }
              // A focused video answers the keyboard itself - Space, the arrows,
              // M - on top of the handlers here and in the sidebar walk, so every
              // key would act twice. Focus goes to the pane instead; the mouse
              // still works the controls.
              onFocus={() => containerRef.current?.focus({ preventScroll: true })}
              onLoadedMetadata={handleLoadedMetadata}
              onError={() => setFailed(true)}
            />
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300 truncate max-w-xs">{filename}</span>
        {info && info.width > 0 && (
          <span className="text-neutral-500">
            {info.width} × {info.height}
          </span>
        )}
        {info && Number.isFinite(info.duration) && (
          <span className="text-neutral-500">{formatDuration(info.duration)}</span>
        )}
        {fileSize !== null && <span className="text-neutral-500">{formatSize(fileSize)}</span>}
      </div>
    </div>
  );
}
