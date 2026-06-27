import type { ChatStatus } from '../../store/chat-store';

/**
 * Maps a chat-status transition to a single screen-reader announcement, or
 * null when nothing should be announced.
 *
 * Streaming text itself is NOT announced (the streaming node is `aria-live=off`);
 * we announce only the meaningful state changes — start, completion, error —
 * through one polite `role=status` region, so assistive tech speaks start and
 * completion once each rather than re-reading on every token.
 */
export function streamAnnouncement(
  prev: ChatStatus,
  next: ChatStatus,
  error: string | null
): string | null {
  if (next === prev) return null;
  if (next === 'streaming') return 'Generating response…';
  if (next === 'error') return error ? `Error: ${error}` : 'Response failed';
  if (prev === 'streaming' && next === 'idle') return 'Response ready';
  return null;
}
