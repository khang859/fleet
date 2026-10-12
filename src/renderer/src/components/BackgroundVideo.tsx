import { useEffect, useRef } from 'react';
import type { TerminalBackgroundFit } from '../../../shared/types';
import { toFleetMediaUrl } from '../../../shared/path-platform';
import { usePageVisible } from '../hooks/use-page-visible';
import { videoObjectFit } from '../lib/background-style';
import { releaseVideo, reportUnplayableBackground } from '../lib/background-video';

type BackgroundVideoProps = {
  path: string;
  fit: TerminalBackgroundFit;
  /** The first frame is in, so there is something to fade to. */
  onReady?: () => void;
  /** It cannot be played. The user has already been told. */
  onError?: () => void;
};

/**
 * A video drawn as a background: silent, looping, and nothing the keyboard or
 * the mouse can reach. Fills the box it is put in, which is where the blur, the
 * feathered edges and the opacity are applied.
 */
export function BackgroundVideo({
  path,
  fit,
  onReady,
  onError
}: BackgroundVideoProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const visible = usePageVisible();

  // The source is set here rather than as a prop so that it is this effect's to
  // take away again: a video that has faded out is still decoding until its
  // source is gone.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.src = toFleetMediaUrl(path);
    return () => releaseVideo(video);
  }, [path]);

  // A window nobody can see has no use for a decoder. Pausing keeps the
  // position, so coming back carries on from the same frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // play() rejects when a pause interrupts it, which is not an error here.
    if (visible) video.play().catch(() => {});
    else video.pause();
  }, [visible, path]);

  const unplayable = (): void => {
    reportUnplayableBackground(path);
    onError?.();
  };

  return (
    <video
      ref={videoRef}
      muted
      loop
      playsInline
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      aria-hidden
      className="block w-full h-full pointer-events-none"
      style={{ objectFit: videoObjectFit(fit), objectPosition: 'center' }}
      // A container can load as sound over a picture that will not decode,
      // which is as unplayable as one that does not open.
      onLoadedData={(e) => (e.currentTarget.videoWidth > 0 ? onReady?.() : unplayable())}
      onError={unplayable}
    />
  );
}
