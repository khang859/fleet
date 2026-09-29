export type Rect = { x: number; y: number; width: number; height: number };

export type DisplayArea = { id: number; workArea: Rect };

/** Where the overlay was last left on each display, keyed by display id. */
export type SavedBounds = {
  lastDisplayId: number | null;
  byDisplay: Record<string, Rect>;
};

export const MIN_WINDOW_WIDTH = 240;
export const MIN_WINDOW_HEIGHT = 96;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 200;
const DEFAULT_TOP_MARGIN = 24;

/**
 * Top centre of the display: right under a laptop's built-in camera, which is
 * where the eyes should be. Users with a camera elsewhere drag it there once.
 */
export function defaultRect(workArea: Rect): Rect {
  const width = Math.min(DEFAULT_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_HEIGHT, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + DEFAULT_TOP_MARGIN,
    width,
    height
  };
}

/**
 * Fit a rect wholly inside a work area, shrinking it first if it is larger.
 *
 * Uses the rect's own size, so a wide overlay saved at the right edge comes
 * back fully on screen rather than hanging off it.
 */
export function clampRect(rect: Rect, workArea: Rect): Rect {
  const width = Math.min(workArea.width, Math.max(MIN_WINDOW_WIDTH, Math.round(rect.width)));
  const height = Math.min(workArea.height, Math.max(MIN_WINDOW_HEIGHT, Math.round(rect.height)));
  const x = Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, Math.round(rect.x)));
  const y = Math.min(
    workArea.y + workArea.height - height,
    Math.max(workArea.y, Math.round(rect.y))
  );
  return { x, y, width, height };
}

/**
 * Where to open the overlay: where it was last left, on the display it was
 * last on, when that display is still connected. Otherwise the primary
 * display, at the spot it had there or the default.
 */
export function resolveInitialBounds(
  saved: SavedBounds,
  displays: DisplayArea[],
  primaryId: number
): Rect {
  const display =
    displays.find((d) => d.id === saved.lastDisplayId) ??
    displays.find((d) => d.id === primaryId) ??
    displays[0];
  const rect = saved.byDisplay[String(display.id)] ?? defaultRect(display.workArea);
  return clampRect(rect, display.workArea);
}
