/**
 * Motion design tokens — the source of truth for the app's easing + duration
 * ramp. ease-out-quart decelerates fast then settles (used for content, e.g.
 * chat messages); ease-out-expo decelerates harder for a snappier feel and is
 * the standard for overlays (menus, tooltips, dialogs, toasts). Durations (ms)
 * scale from a quick tap to a larger transition. Pair with Tailwind
 * `duration-[…]`/`ease-[…]` utilities (the class strings below bake in these
 * literal values so Tailwind's JIT can scan them — keep the two in sync).
 */
export const motionTokens = {
  easeOutQuart: 'cubic-bezier(.25,1,.5,1)',
  easeOutExpo: 'cubic-bezier(.16,1,.3,1)',
  duration: { fast: 100, base: 150, slow: 220, slower: 320 }
} as const;

/**
 * Shared timing for overlay enter/exit: ease-out-expo, with exits faster than
 * entrances (150ms in, 100ms out) so dismissing something never feels like it
 * lingers. Compose into a component's animate-in/out classes.
 */
export const overlayTiming =
  'ease-[cubic-bezier(.16,1,.3,1)] data-[state=open]:duration-150 data-[state=closed]:duration-100';

/** Exit duration (ms) matching `overlayTiming`'s `data-[state=closed]:duration-100` — pass to `usePresence` so unmount doesn't cut the animation short. */
export const overlayExitMs = 100;

/**
 * Shared animation class strings for Radix primitives. Radix toggles
 * `data-[state]` (and `data-[side]` for popper content) and its built-in
 * Presence holds the element mounted while a `data-[state=closed]` animation
 * runs, so these give enter/exit without any JS. Reduced-motion users have
 * `animate-in`/`animate-out` neutralized in index.css.
 */

/** Popper-positioned content (context menus, popovers): side-aware slide + zoom/fade. */
export const popperAnim = `${overlayTiming} data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1`;

/** Tooltip content — its open state is `delayed-open`/`instant-open`, so enter is unconditional. */
export const tooltipAnim = `duration-150 ease-[cubic-bezier(.16,1,.3,1)] animate-in fade-in-0 zoom-in-95 data-[state=closed]:duration-100 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95`;

/** Dialog overlay + content. Fade only — these center via translate, which a zoom keyframe would fight. */
export const dialogFadeAnim = `${overlayTiming} data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0`;

/**
 * New-message entrance. Assistant slides up + fades (~220ms); user message
 * fades only (~150ms). Enter-only (fires once on mount via tw-animate-css), so
 * messages already on screen never re-animate or reflow — which would fight the
 * stick-to-bottom scroll engine. Reduced-motion neutralizes `animate-in` in
 * index.css (instant, full opacity, no transform).
 */
export const messageEnterAssistant =
  'animate-in fade-in slide-in-from-bottom-2 duration-[220ms] ease-[cubic-bezier(.25,1,.5,1)]';
export const messageEnterUser = 'animate-in fade-in duration-150 ease-[cubic-bezier(.25,1,.5,1)]';
