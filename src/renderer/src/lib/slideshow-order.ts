/**
 * Build the next play-through queue for the background slideshow.
 *
 * Sequential: filename order, rotated so playback continues after `lastShown`.
 * Shuffle: Fisher-Yates, re-rolled each cycle; guarantees `lastShown` is not
 * first so the same image never shows twice in a row (when there are 2+ images).
 */
export function buildQueue(paths: string[], shuffle: boolean, lastShown: string | null): string[] {
  if (paths.length === 0) return [];
  if (!shuffle) {
    const start = lastShown ? paths.indexOf(lastShown) + 1 : 0;
    return start > 0 ? [...paths.slice(start), ...paths.slice(0, start)] : [...paths];
  }
  const queue = [...paths];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  if (queue.length > 1 && queue[0] === lastShown) {
    const k = 1 + Math.floor(Math.random() * (queue.length - 1));
    [queue[0], queue[k]] = [queue[k], queue[0]];
  }
  return queue;
}
