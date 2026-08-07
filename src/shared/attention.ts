import { z } from 'zod';
import type { NotificationLevel } from './types';

/**
 * What the renderer is allowed to tell main about panes.
 *
 * Parsed rather than trusted: these two arrive as fire-and-forget messages and
 * decide how loudly Fleet interrupts the user, so a malformed one is dropped
 * rather than half-applied.
 */
export const VisiblePanesSchema = z.array(z.string().min(1)).max(1000);

export const ActivityReportSchema = z.object({
  paneId: z.string().min(1),
  state: z.enum(['working', 'idle', 'done', 'needs_me', 'error', 'gone']),
  /** What to call this pane when telling the user about it, if it knows. */
  label: z.string().min(1).max(80).optional()
});

/**
 * How far the user is from the pane that wants them.
 *
 * Every alert Fleet raises is chosen by this distance, because the same event
 * deserves a different volume depending on where the user already is. A
 * question on a pane they are looking at needs no announcement; the same
 * question with Fleet behind a browser needs to leave the app entirely.
 */
export type Attention = 'here' | 'nearby' | 'away';

export function attentionOf({
  windowFocused,
  paneVisible
}: {
  windowFocused: boolean;
  paneVisible: boolean;
}): Attention {
  if (!windowFocused) return 'away';
  return paneVisible ? 'here' : 'nearby';
}

/** The three ways a pane can ask for the user, each independently opt-out-able. */
export type NotificationChannels = { badge: boolean; sound: boolean; os: boolean };

export type Alerts = {
  /** The in-app chime. */
  chime: boolean;
  /** A desktop notification, which carries a sound of its own. */
  os: boolean;
  /** The tab dot, sidebar glyph, dock badge and window title. */
  badge: boolean;
};

const NONE: Alerts = { chime: false, os: false, badge: false };

/**
 * What to raise for one event, given where the user is and what they allowed.
 *
 * Two rules hold this together. **At most one sound per event**: `away` is
 * answered by a desktop notification, which rings on its own, so the chime
 * stands down rather than beating it to the same news. And **`here` is silent**
 * - the pane is on screen and already says everything an alert would, so
 * interrupting is telling the user what they are looking at.
 *
 * The badge is the exception that always applies: it is the one channel that
 * costs nothing to miss and is still there when the user comes back.
 */
export function alertsFor(
  attention: Attention,
  level: NotificationLevel,
  channels: NotificationChannels
): Alerts {
  // Nothing subtle is worth an interruption at any distance; it is a badge or
  // it is nothing.
  if (level === 'subtle') return { ...NONE, badge: channels.badge };

  const badge = channels.badge;
  switch (attention) {
    case 'here':
      return { ...NONE, badge };
    case 'nearby':
      return { chime: channels.sound, os: false, badge };
    case 'away':
      // Falls back to the chime when the user has silenced desktop
      // notifications but not sound: the event still happened, and Fleet being
      // in the background is not a reason to say less than it would have said.
      return { chime: !channels.os && channels.sound, os: channels.os, badge };
  }
}

/** Which settings group speaks for a level. */
export function channelsKeyFor(
  level: NotificationLevel
): 'needsPermission' | 'processExitError' | 'taskComplete' | 'processExitClean' {
  switch (level) {
    case 'permission':
      return 'needsPermission';
    case 'error':
      return 'processExitError';
    case 'info':
      return 'taskComplete';
    case 'subtle':
      return 'processExitClean';
  }
}
