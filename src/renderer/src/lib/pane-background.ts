import type { TerminalBackground } from '../../../shared/types';
import type { SlideshowFrame } from '../hooks/use-slideshow';

/**
 * The image a pane's background layer is showing right now: the slideshow's
 * current frame once the clock has advanced, else the static image.
 *
 * `BackgroundLayer` paints whatever this returns, and the panes that have to
 * react to a picture being there - xterm going transparent, the agent pane's
 * chrome going glass - ask the same question here rather than re-deriving it,
 * so none of them can disagree with what is actually on screen.
 */
export function resolveBackgroundSrc(
  background: TerminalBackground | undefined,
  frame: SlideshowFrame | undefined
): string | null {
  if (!background) return null;
  if (background.slideshow.enabled && frame?.currentPath) return frame.currentPath;
  return background.imagePath;
}
