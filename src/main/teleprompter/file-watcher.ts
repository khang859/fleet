import { watch as fsWatch } from 'fs';
import { basename, dirname } from 'path';
import { createLogger } from '../logger';

const log = createLogger('teleprompter:watcher');

export type WatchFn = (
  dir: string,
  listener: (event: string, filename: string | null) => void
) => { close: () => void };

const defaultWatch: WatchFn = (dir, listener) => {
  const watcher = fsWatch(dir, { persistent: false }, listener);
  // A watched folder that is deleted or unmounted errors here rather than
  // throwing; the next reload reports the missing file.
  watcher.on('error', (err) => log.warn('watch error', { dir, error: err.message }));
  return watcher;
};

/**
 * Calls back when one file changes on disk.
 *
 * Watches the file's folder, not the file: most editors save by writing a
 * temp file and renaming it over the original, which leaves a watch on the
 * old inode deaf to every later save.
 */
export class FileWatcher {
  private watcher: { close: () => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly watch: WatchFn = defaultWatch,
    private readonly debounceMs = 150
  ) {}

  start(filePath: string, onChange: () => void): void {
    this.stop();
    const name = basename(filePath);
    this.watcher = this.watch(dirname(filePath), (_event, filename) => {
      // Some platforms do not say which file changed; reloading is cheap.
      if (filename !== null && filename !== name) return;
      if (this.timer) clearTimeout(this.timer);
      // One save is often several events (truncate, write, rename).
      this.timer = setTimeout(() => {
        this.timer = null;
        onChange();
      }, this.debounceMs);
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
