import { toFleetMediaUrl } from '../../../shared/path-platform';
import { useToastStore } from '../store/toast-store';
import { getBasename } from './file-display';

/** Let go of a video's decoder now. Taking the element out of the page only
 *  pauses it - the player behind it lives on until it is garbage collected. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute('src');
  video.load();
}

/**
 * Whether Chromium on this machine can show a frame of this video.
 *
 * Asked by actually decoding one, because nothing else knows: `.mov` and `.mp4`
 * are boxes, and whether the codec inside plays depends on the build and the
 * platform. Run on the file where the user picked it, before it is copied, so
 * one that cannot play is never stored at all.
 */
export async function canPlayVideo(path: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const settle = (playable: boolean): void => {
      clearTimeout(timer);
      video.onloadeddata = null;
      video.onerror = null;
      releaseVideo(video);
      resolve(playable);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    // A container can open with a picture codec that cannot be decoded, and
    // load as sound over nothing - which is no background.
    video.onloadeddata = () => settle(video.videoWidth > 0);
    video.onerror = () => settle(false);
    video.muted = true;
    video.preload = 'auto';
    video.src = toFleetMediaUrl(path);
  });
}

const reported = new Set<string>();

/** Say that a background video stopped being playable - once for each file,
 *  however many places are trying to draw it. */
export function reportUnplayableBackground(path: string): void {
  if (reported.has(path)) return;
  reported.add(path);
  useToastStore.getState().show(`${getBasename(path)} could not be played as a background`);
}
