import { useEffect, useRef, useState } from 'react';
import type { TerminalBackground } from '../../../shared/types';
import { toFleetImageUrl } from '../../../shared/path-platform';
import { buildQueue } from '../lib/slideshow-order';

export type SlideshowFrame = {
  /** Image currently shown (fading in while previousPath is set). */
  currentPath: string | null;
  /** Image fading out beneath the current one; cleared when the fade ends. */
  previousPath: string | null;
};

const IDLE_FRAME: SlideshowFrame = { currentPath: null, previousPath: null };

// Decode through Chromium's image cache so the crossfade never reveals a
// half-loaded image. Resolves on error too — a missing file just renders
// as an empty layer and the show moves on.
async function preloadImage(path: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = toFleetImageUrl(path);
  });
}

/**
 * Single global slideshow clock for the terminal background. Called once in
 * App; every pane consumes the returned frame so all panes transition in sync.
 */
export function useSlideshow(bg: TerminalBackground | undefined): SlideshowFrame {
  const [frame, setFrame] = useState<SlideshowFrame>(IDLE_FRAME);

  const queueRef = useRef<string[]>([]);
  const lastShownRef = useRef<string | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read at fade time via a ref so moving the transition slider doesn't
  // restart the interval (and postpone the next image).
  const transitionMsRef = useRef(1000);
  transitionMsRef.current = bg?.slideshow.transitionMs ?? 1000;

  const slideshow = bg?.slideshow;
  const enabled = slideshow?.enabled ?? false;
  const source = slideshow?.source ?? 'folder';
  const folderPath = slideshow?.folderPath ?? '';
  const filePathsKey = (slideshow?.filePaths ?? []).join('\n');
  const intervalSeconds = slideshow?.intervalSeconds ?? 60;
  const shuffle = slideshow?.shuffle ?? true;

  useEffect(() => {
    if (!enabled) {
      queueRef.current = [];
      lastShownRef.current = null;
      setFrame(IDLE_FRAME);
      return;
    }

    const run = { cancelled: false, advancing: false };
    const filePaths = filePathsKey ? filePathsKey.split('\n') : [];

    // Re-resolves the source list on every advance so files added to or
    // removed from a folder are picked up without a settings change.
    const advance = async (initial: boolean): Promise<void> => {
      // If a slow scan/preload outlives the interval, skip this tick rather
      // than dequeue a second image the first call would then clobber.
      if (run.advancing) return;
      run.advancing = true;
      try {
        await advanceInner(initial);
      } finally {
        run.advancing = false;
      }
    };

    const advanceInner = async (initial: boolean): Promise<void> => {
      const paths =
        source === 'folder' ? await window.fleet.file.scanImageFolder(folderPath) : filePaths;
      if (run.cancelled) return;
      if (paths.length === 0) {
        queueRef.current = [];
        setFrame(IDLE_FRAME);
        return;
      }
      // On (re)start — first show or a settings change — keep the image already
      // on screen rather than jumping, as long as it still exists in the list.
      const lastShown = lastShownRef.current;
      if (initial && lastShown && paths.includes(lastShown)) {
        setFrame({ currentPath: lastShown, previousPath: null });
        return;
      }
      queueRef.current = queueRef.current.filter((p) => paths.includes(p));
      if (queueRef.current.length === 0) {
        queueRef.current = buildQueue(paths, shuffle, lastShownRef.current);
      }
      const next = queueRef.current.shift();
      if (!next || (next === lastShownRef.current && !initial)) return;
      await preloadImage(next);
      // The cleanup can flip this during the await; the linter can't see that.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (run.cancelled) return;
      lastShownRef.current = next;
      setFrame((prev) => ({
        currentPath: next,
        previousPath: initial ? null : prev.currentPath
      }));
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => {
        setFrame((prev) => ({ ...prev, previousPath: null }));
      }, transitionMsRef.current + 80);
    };

    void advance(true);
    const interval = setInterval(() => void advance(false), intervalSeconds * 1000);
    return () => {
      run.cancelled = true;
      clearInterval(interval);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [enabled, source, folderPath, filePathsKey, intervalSeconds, shuffle]);

  return frame;
}
