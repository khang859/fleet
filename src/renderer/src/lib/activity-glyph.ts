import type { ActivityState } from '../../../shared/types';

/** Process liveness: driving output, at rest but still running, or exited. */
export type Liveness = 'alive' | 'sleeping' | 'exited';

/**
 * Two-axis pane status: color encodes semantic state, shape encodes process
 * liveness. `done`/`error` mean the process exited (still inspectable, not
 * driving); `idle` means the process is alive but at rest; `working`/
 * `needs_me` mean it's actively alive.
 */
export function activityLiveness(state: ActivityState | undefined): Liveness {
  if (state === 'done' || state === 'error') return 'exited';
  if (state === undefined || state === 'idle') return 'sleeping';
  return 'alive';
}

type Hue = 'amber' | 'red' | 'green' | 'blue' | 'neutral';

/** Universal color rule: yellow = needs you, green = done, red = errored. */
const HUE: Record<ActivityState, Hue> = {
  needs_me: 'amber',
  error: 'red',
  done: 'green',
  working: 'blue',
  idle: 'neutral'
};

const HUE_BG: Record<Hue, string> = {
  amber: 'bg-amber-400',
  red: 'bg-red-500',
  green: 'bg-green-500',
  blue: 'bg-blue-400',
  neutral: 'bg-fleet-text-subtle'
};

const HUE_BORDER: Record<Hue, string> = {
  amber: 'border-amber-400',
  red: 'border-red-500',
  green: 'border-green-500',
  blue: 'border-blue-400',
  neutral: 'border-fleet-text-subtle'
};

/** Pane border ring — reserved for states that warrant attention; `working`/`idle` stay neutral so a busy pane isn't visually loud. */
const RING_CLASS: Record<Hue, string> = {
  amber: 'ring-2 ring-amber-400',
  red: 'ring-2 ring-red-500/70',
  green: 'ring-1 ring-green-500/50',
  blue: 'ring-1 ring-fleet-border/50',
  neutral: 'ring-1 ring-fleet-border/50'
};

function hue(state: ActivityState | undefined): Hue {
  return state ? HUE[state] : 'neutral';
}

export function activityBgClass(state: ActivityState | undefined): string {
  return HUE_BG[hue(state)];
}

export function activityBorderClass(state: ActivityState | undefined): string {
  return HUE_BORDER[hue(state)];
}

export function activityRingClass(state: ActivityState | undefined): string {
  return RING_CLASS[hue(state)];
}
