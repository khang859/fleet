/**
 * Shared button class strings. Centralizes the tactile press feedback
 * (`active:scale-*`) and transition timing so interactive controls feel
 * consistent app-wide. Reduced-motion users get the scale neutralized in
 * index.css. Compose with extra classes via a template literal at the call site.
 */

/** Primary action (blue). Use for the main confirm/submit button in a surface. */
export const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition active:scale-[0.97] hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:active:scale-100';

/** Neutral pill (Save / secondary actions). */
export const neutralBtn =
  'inline-flex items-center justify-center gap-2 rounded-md bg-neutral-700 px-3 py-2 text-sm text-neutral-100 transition active:scale-[0.97] hover:bg-neutral-600 disabled:text-neutral-500 disabled:active:scale-100';
