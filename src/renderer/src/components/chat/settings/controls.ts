/**
 * Shared control class strings for the Chat settings panes. Centralizes the
 * native input/select look so every field is visually consistent. Compose with
 * width utilities at the call site (e.g. `${inputCls} w-24`).
 */

export const inputCls =
  'rounded-md border border-fleet-border-strong bg-fleet-surface-2 px-2.5 py-1.5 text-sm text-fleet-text outline-none transition-colors focus:border-fleet-text-subtle placeholder:text-fleet-text-subtle';

export const selectCls = `${inputCls} cursor-pointer`;
