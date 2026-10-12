import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalBackground } from '../../../shared/types';
import { backgroundMediaKind } from '../../../shared/background-media';
import { toFleetImageUrl } from '../../../shared/path-platform';
import { buildQueue } from '../lib/slideshow-order';

export type SlideshowFrame = {
  /** The image or video the show is on. */
  currentPath: string | null;
};

const IDLE_FRAME: SlideshowFrame = { currentPath: null };

// Decode through Chromium's image cache so the crossfade never reveals a
// half-loaded image. Resolves on error too — a missing file just renders
// as an empty layer and the show moves on. A video cannot be warmed this way:
// the layer that plays it holds the crossfade until it has a frame instead.
async function preloadImage(path: string): Promise<void> {
  if (backgroundMediaKind(path) === 'video') return;
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
 *
 * `skip` is for whoever draws the frame to say it could not: the show leaves
 * that file out from then on, and moves off it at once if it is the one up.
 */
export function useSlideshow(bg: TerminalBackground | undefined): {
  frame: SlideshowFrame;
  skip: (path: string) => void;
} {
  const [frame, setFrame] = useState<SlideshowFrame>(IDLE_FRAME);

  const queueRef = useRef<string[]>([]);
  const lastShownRef = useRef<string | null>(null);
  // Files that would not play. Forgotten whenever the show is set up again, so
  // one that has been replaced or restored gets another go.
  const unplayableRef = useRef(new Set<string>());
  const advanceRef = useRef<(() => void) | null>(null);

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
    const unplayable = new Set<string>();
    unplayableRef.current = unplayable;
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
      const listed =
        source === 'folder' ? await window.fleet.file.scanImageFolder(folderPath) : filePaths;
      if (run.cancelled) return;
      const paths = listed.filter((p) => !unplayable.has(p));
      if (paths.length === 0) {
        queueRef.current = [];
        setFrame(IDLE_FRAME);
        return;
      }
      // On (re)start — first show or a settings change — keep the image already
      // on screen rather than jumping, as long as it still exists in the list.
      const lastShown = lastShownRef.current;
      if (initial && lastShown && paths.includes(lastShown)) {
        setFrame({ currentPath: lastShown });
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
      setFrame({ currentPath: next });
    };

    void advance(true);
    advanceRef.current = () => void advance(false);
    const interval = setInterval(() => void advance(false), intervalSeconds * 1000);
    return () => {
      run.cancelled = true;
      advanceRef.current = null;
      clearInterval(interval);
    };
  }, [enabled, source, folderPath, filePathsKey, intervalSeconds, shuffle]);

  const skip = useCallback((path: string): void => {
    unplayableRef.current.add(path);
    if (path === lastShownRef.current) advanceRef.current?.();
  }, []);

  return { frame, skip };
}
