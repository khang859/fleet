/**
 * Shared animation class strings for Radix primitives. Radix toggles
 * `data-[state]` (and `data-[side]` for popper content) and its built-in
 * Presence holds the element mounted while a `data-[state=closed]` animation
 * runs, so these give symmetric enter/exit without any JS. Reduced-motion users
 * have `animate-in`/`animate-out` neutralized in index.css.
 */

/** Popper-positioned content (context menus, popovers): side-aware slide + zoom/fade. */
export const popperAnim =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1';

/** Tooltip content — its open state is `delayed-open`/`instant-open`, so enter is unconditional. */
export const tooltipAnim =
  'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95';

/** Dialog overlay + content. Fade only — these center via translate, which a zoom keyframe would fight. */
export const dialogFadeAnim =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0';
