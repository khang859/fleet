export type MediaKeyCommand = 'toggle' | 'seek-back' | 'seek-forward' | 'mute';

export const MEDIA_SEEK_SECONDS = 5;

/**
 * What a bare key does to the player on screen, or null when it is not the
 * player's key. Anything with a modifier is left for the app's own shortcuts,
 * and Up/Down are absent on purpose: on a media tab they walk the sidebar.
 */
export function mediaKeyCommand(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): MediaKeyCommand | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  switch (e.key) {
    case ' ':
      return 'toggle';
    case 'ArrowLeft':
      return 'seek-back';
    case 'ArrowRight':
      return 'seek-forward';
    case 'm':
    case 'M':
      return 'mute';
    default:
      return null;
  }
}
