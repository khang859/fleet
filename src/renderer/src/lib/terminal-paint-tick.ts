/**
 * One timer for every pane that defers its output.
 *
 * Panes that each keep their own timer paint at different moments, so 8 panes
 * can force far more frames than one pane. On a shared tick they all write in
 * the same frame.
 */
export const PAINT_TICK_MS = 250;

const due = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function runTick(): void {
  timer = null;
  const flushes = [...due];
  due.clear();

  for (const flush of flushes) flush();
}

/** Run `flush` on the next tick. Adding the same function twice runs it once. */
export function onNextPaintTick(flush: () => void): void {
  due.add(flush);
  timer ??= setTimeout(runTick, PAINT_TICK_MS);
}

export function cancelPaintTick(flush: () => void): void {
  due.delete(flush);
}
