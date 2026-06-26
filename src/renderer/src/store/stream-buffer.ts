/**
 * Coalesces high-frequency stream deltas into throttled flushes.
 *
 * SSE tokens arrive far faster than the screen needs to repaint. Pushing each
 * token straight into React state triggers a re-render + full markdown re-parse
 * per token — a storm that grows with conversation length. This buffer
 * accumulates deltas in memory and flushes at most once per `flushMs`, keeping
 * visible updates smooth (~20/s) while collapsing the render work.
 */
export class StreamBuffer {
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushMs: number,
    private readonly onFlush: (delta: string) => void
  ) {}

  /** Queue a delta; schedules a trailing flush if one isn't already pending. */
  push(delta: string): void {
    if (!delta) return;
    this.pending += delta;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushMs);
    }
  }

  /** Emit any buffered text immediately and cancel the pending timer. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const delta = this.pending;
    this.pending = '';
    this.onFlush(delta);
  }

  /** Drop any buffered text without emitting (stream done/error/cancelled). */
  reset(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = '';
  }
}
