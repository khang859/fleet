/** A task repeated in the background that does not keep Fleet running. Started once, stopped at close. */
export class Ticker {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(tick: () => void, intervalMs: number): void {
    this.timer ??= setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
