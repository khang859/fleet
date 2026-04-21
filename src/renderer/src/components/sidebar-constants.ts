/** Default sidebar width in pixels (matches Tailwind `w-56` = 14rem = 224px). */
export const DEFAULT_SIDEBAR_WIDTH = 224;

/** Minimum resizable sidebar width — below this, tab labels become unreadable. */
export const MIN_SIDEBAR_WIDTH = 180;

/** Maximum sidebar width as a fraction of `window.innerWidth`. */
export const MAX_SIDEBAR_WIDTH_RATIO = 0.9;

/**
 * Clamp a raw sidebar width (pixels) against min/max bounds.
 * `viewportWidth` must be provided so the function is testable without `window`.
 */
export function clampSidebarWidth(rawWidth: number, viewportWidth: number): number {
  const max = viewportWidth * MAX_SIDEBAR_WIDTH_RATIO;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(rawWidth, max));
}
